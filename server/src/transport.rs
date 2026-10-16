//! Bounded reliable traffic and replaceable state share a single socket writer.
//! Publishing never awaits the network, and the reader runs independently.
use axum::extract::ws::Message;
use futures_util::{Sink, SinkExt};
use serde_json::Value;
use std::{
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};

const RELIABLE_CAPACITY: usize = 128;
const SEND_TIMEOUT: Duration = Duration::from_secs(2);
/// Wall-clock gate for state publication after catch-up. Simulation cadence
/// still decides when state is due; this prevents multiple catch-up batches
/// from dumping historical snapshots across adjacent scheduler wakeups.
#[derive(Default)]
pub struct SnapshotPacer {
    last: Option<Instant>,
}
impl SnapshotPacer {
    pub fn ready(&self, now: Instant) -> bool {
        // Half a tick of tolerance absorbs normal 60 Hz scheduler jitter while
        // retaining a >=41.7 ms gap (nominal publication cadence is 50 ms).
        let minimum = Duration::from_secs_f64(2.5 / 60.0);
        if self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) < minimum)
        {
            return false;
        }
        true
    }
    pub fn published(&mut self, now: Instant) {
        self.last = Some(now);
    }
}
#[derive(Default)]
pub struct Metrics {
    pub snapshots_published: AtomicU64,
    pub snapshots_replaced: AtomicU64,
    pub snapshots_sent: AtomicU64,
    pub reliable_sent: AtomicU64,
    pub max_queue_age_us: AtomicU64,
    pub send_timeouts: AtomicU64,
    claimed_snapshot: AtomicU64,
}
/// Immutable payloads are captured while the Hub is locked, then encoded once
/// by a socket writer. Arc clones share both the DTO and the encoded bytes.
/// Keeping publication synchronous preserves lifecycle/state ordering without
/// doing JSON or MessagePack serialization inside either publisher or Hub lock.
pub struct WirePayload {
    source: WireSource,
    encoded: OnceLock<Message>,
}
enum WireSource {
    Value(Value),
    Snapshot(crate::codec::Snapshot),
    Joined {
        lobby_name: String,
        actor_id: u32,
        cue_seq: u64,
        snapshot: crate::codec::Snapshot,
    },
    Control(Message),
}
impl WirePayload {
    pub fn value(value: Value) -> Arc<Self> {
        Self::new(WireSource::Value(value))
    }
    pub fn snapshot(snapshot: crate::codec::Snapshot) -> Arc<Self> {
        Self::new(WireSource::Snapshot(snapshot))
    }
    pub fn joined(
        lobby_name: String,
        actor_id: u32,
        cue_seq: u64,
        snapshot: crate::codec::Snapshot,
    ) -> Arc<Self> {
        Self::new(WireSource::Joined {
            lobby_name,
            actor_id,
            cue_seq,
            snapshot,
        })
    }
    fn new(source: WireSource) -> Arc<Self> {
        Arc::new(Self {
            source,
            encoded: OnceLock::new(),
        })
    }
    fn message(&self) -> &Message {
        self.encoded.get_or_init(|| match &self.source {
            WireSource::Value(value) => Message::Text(value.to_string().into()),
            WireSource::Snapshot(snapshot) => Message::Binary(
                crate::codec::encode_snapshot(snapshot)
                    .expect("serializable snapshot")
                    .into(),
            ),
            WireSource::Joined {
                lobby_name,
                actor_id,
                cue_seq,
                snapshot,
            } => Message::Text(
                serde_json::json!({
                    "type":"joined", "lobbyId":snapshot.lobby_id, "lobbyName":lobby_name,
                    "actorId":actor_id, "cueSeq":cue_seq, "snapshot":snapshot.named(),
                })
                .to_string()
                .into(),
            ),
            WireSource::Control(message) => message.clone(),
        })
    }
    #[cfg(test)]
    fn named(&self) -> Value {
        match &self.source {
            WireSource::Snapshot(snapshot) => snapshot.named(),
            _ => match self.message() {
                Message::Text(text) => serde_json::from_str(text).unwrap(),
                _ => panic!("expected data"),
            },
        }
    }
}
#[derive(Clone)]
struct Packet {
    payload: Arc<WirePayload>,
    queued: Instant,
    sequence: u64,
    after_reliable: u64,
}
struct Publisher {
    reliable: mpsc::Sender<Packet>,
    latest: watch::Sender<Option<Packet>>,
    reliable_sequence: u64,
    state_sequence: u64,
}
#[derive(Clone)]
pub struct Outbox {
    publisher: Arc<Mutex<Publisher>>,
    pub metrics: Arc<Metrics>,
}
pub struct Outgoing {
    reliable: mpsc::Receiver<Packet>,
    latest: watch::Receiver<Option<Packet>>,
    metrics: Arc<Metrics>,
    reliable_sent: u64,
}
/// Durable events may emerge together after a storage stall. Keep every wire
/// batch within the client's bound, preserving sequence and event order.
pub fn event_batches(
    lobby: &str,
    round: u64,
    tick: u64,
    time: f64,
    sequence: &mut u64,
    events: Vec<Value>,
) -> Vec<Value> {
    events.chunks(128).map(|events| {
        *sequence += 1;
        serde_json::json!({"type":"events","lobbyId":lobby,"roundNumber":round,"tick":tick,"time":time,"eventSeq":*sequence,"events":events})
    }).collect()
}
pub fn channel() -> (Outbox, Outgoing) {
    channel_with_capacity(RELIABLE_CAPACITY)
}
fn channel_with_capacity(capacity: usize) -> (Outbox, Outgoing) {
    let (reliable, receiver) = mpsc::channel(capacity);
    let (latest, snapshots) = watch::channel(None);
    let metrics = Arc::new(Metrics::default());
    (
        Outbox {
            publisher: Arc::new(Mutex::new(Publisher {
                reliable,
                latest,
                reliable_sequence: 0,
                state_sequence: 0,
            })),
            metrics: metrics.clone(),
        },
        Outgoing {
            reliable: receiver,
            latest: snapshots,
            metrics,
            reliable_sent: 0,
        },
    )
}
impl Outbox {
    pub fn diagnostics(&self) -> Value {
        serde_json::json!({
            "snapshotsPublished": self.metrics.snapshots_published.load(Ordering::Relaxed),
            "snapshotsReplaced": self.metrics.snapshots_replaced.load(Ordering::Relaxed),
            "snapshotsSent": self.metrics.snapshots_sent.load(Ordering::Relaxed),
            "reliableSent": self.metrics.reliable_sent.load(Ordering::Relaxed),
            "maxQueueAgeMs": self.metrics.max_queue_age_us.load(Ordering::Relaxed) as f64 / 1000.0,
            "sendTimeouts": self.metrics.send_timeouts.load(Ordering::Relaxed),
        })
    }
    pub fn send(&self, value: Value) -> bool {
        let reset = value["type"] == "joined" || value["type"] == "left";
        self.send_shared(WirePayload::value(value), reset)
    }
    pub fn send_shared(&self, payload: Arc<WirePayload>, reset_state: bool) -> bool {
        let mut publisher = self.publisher.lock().expect("outbox publisher");
        if reset_state {
            publisher.latest.send_replace(None);
        }
        Self::enqueue(&mut publisher, payload)
    }

    pub fn control(&self, message: Message) -> bool {
        Self::enqueue(
            &mut self.publisher.lock().expect("outbox publisher"),
            WirePayload::new(WireSource::Control(message)),
        )
    }
    fn enqueue(publisher: &mut Publisher, payload: Arc<WirePayload>) -> bool {
        let sequence = publisher.reliable_sequence + 1;
        if publisher
            .reliable
            .try_send(Packet {
                payload,
                queued: Instant::now(),
                sequence,
                after_reliable: 0,
            })
            .is_err()
        {
            return false;
        }
        publisher.reliable_sequence = sequence;
        true
    }
    #[cfg(test)]
    pub fn snapshot(&self, encoded: String) -> bool {
        self.snapshot_shared(WirePayload::new(WireSource::Control(Message::Text(
            encoded.into(),
        ))))
    }
    pub fn snapshot_shared(&self, payload: Arc<WirePayload>) -> bool {
        let mut publisher = self.publisher.lock().expect("outbox publisher");
        if publisher.latest.is_closed() {
            return false;
        }
        if publisher.latest.borrow().as_ref().is_some_and(|previous| {
            previous.sequence > self.metrics.claimed_snapshot.load(Ordering::Relaxed)
        }) {
            self.metrics
                .snapshots_replaced
                .fetch_add(1, Ordering::Relaxed);
        }
        publisher.state_sequence += 1;
        let packet = Packet {
            payload,
            queued: Instant::now(),
            sequence: publisher.state_sequence,
            after_reliable: publisher.reliable_sequence,
        };
        publisher.latest.send_replace(Some(packet));
        self.metrics
            .snapshots_published
            .fetch_add(1, Ordering::Relaxed);
        true
    }
}
impl Outgoing {
    async fn next(&mut self) -> Option<(Packet, bool)> {
        loop {
            // The reliable barrier on each state also covers a publication race
            // between checking the reliable queue and claiming the watch value.
            if let Ok(packet) = self.reliable.try_recv() {
                return Some((packet, true));
            }
            if self.latest.has_changed().ok()? {
                let state = self.latest.borrow_and_update().clone();
                if let Some(packet) = state {
                    if packet.after_reliable > self.reliable_sent {
                        self.latest.mark_changed();
                        return self.reliable.recv().await.map(|packet| (packet, true));
                    }
                    self.metrics
                        .claimed_snapshot
                        .store(packet.sequence, Ordering::Relaxed);
                    return Some((packet, false));
                }
            }
            tokio::select! {
                biased;
                packet = self.reliable.recv() => return packet.map(|packet| (packet, true)),
                changed = self.latest.changed() => {
                    if changed.is_err() { return None; }
                    // changed() marks the version seen; restore inspection via
                    // mark_changed so all claims go through the barrier above.
                    self.latest.mark_changed();
                }
            }
        }
    }
    fn sent(&mut self, packet: &Packet, reliable: bool) {
        self.metrics.max_queue_age_us.fetch_max(
            packet.queued.elapsed().as_micros().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
        if reliable {
            self.reliable_sent = packet.sequence;
            self.metrics.reliable_sent.fetch_add(1, Ordering::Relaxed);
        } else {
            self.metrics.snapshots_sent.fetch_add(1, Ordering::Relaxed);
        }
    }
    #[cfg(test)]
    pub fn try_recv(&mut self) -> Result<String, mpsc::error::TryRecvError> {
        let packet = self.reliable.try_recv()?;
        self.sent(&packet, true);
        match packet.payload.message() {
            Message::Text(text) => Ok(text.to_string()),
            _ => Err(mpsc::error::TryRecvError::Empty),
        }
    }
}
pub async fn write_socket<S>(
    mut sink: S,
    mut outgoing: Outgoing,
    mut cancelled: watch::Receiver<Option<String>>,
) where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    loop {
        if cancelled.borrow().is_some() {
            break;
        }
        let next = tokio::select! {
            biased;
            _ = cancelled.changed() => None,
            next = outgoing.next() => next,
        };
        let Some((packet, reliable)) = next else {
            break;
        };
        let sent = tokio::select! {
            biased;
            _ = cancelled.changed() => break,
            result = tokio::time::timeout(SEND_TIMEOUT, sink.send(packet.payload.message().clone())) => result,
        };
        match sent {
            Ok(Ok(())) => outgoing.sent(&packet, reliable),
            Ok(Err(error)) => {
                tracing::debug!(%error, "socket writer closed");
                break;
            }
            Err(_) => {
                outgoing
                    .metrics
                    .send_timeouts
                    .fetch_add(1, Ordering::Relaxed);
                tracing::warn!(
                    queue_age_ms = packet.queued.elapsed().as_millis(),
                    "socket send timed out"
                );
                break;
            }
        }
    }
    let reason = cancelled
        .borrow()
        .clone()
        .unwrap_or_else(|| "connection_closed".into());
    // A replaced browser session must not reconnect and evict its replacement.
    // Bound this final attempt too; a blocked sink never retains a socket task.
    let _ = tokio::time::timeout(
        Duration::from_millis(250),
        sink.send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code: if reason == "session_replaced" {
                4001
            } else {
                4002
            },
            reason: reason.into(),
        }))),
    )
    .await;
    tracing::debug!(
        snapshots_sent = outgoing.metrics.snapshots_sent.load(Ordering::Relaxed),
        snapshots_replaced = outgoing.metrics.snapshots_replaced.load(Ordering::Relaxed),
        reliable_sent = outgoing.metrics.reliable_sent.load(Ordering::Relaxed),
        max_queue_age_us = outgoing.metrics.max_queue_age_us.load(Ordering::Relaxed),
        "socket writer finished"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn text(packet: &Packet) -> Value {
        packet.payload.named()
    }
    #[tokio::test]
    async fn slow_consumer_keeps_latest_state_and_every_reliable_event_in_order() {
        let (outbox, mut outgoing) = channel();
        outbox.send(json!({"type":"joined"}));
        for tick in 1..=100 {
            if tick % 20 == 0 {
                assert!(outbox.send(json!({"type":"events","eventSeq":tick / 20})));
            }
            assert!(outbox.snapshot(json!({"type":"snapshot","tick":tick}).to_string()));
        }
        for expected in 0..=5 {
            let (packet, reliable) = outgoing.next().await.unwrap();
            assert!(reliable);
            if expected == 0 {
                assert_eq!(text(&packet)["type"], "joined");
            } else {
                assert_eq!(text(&packet)["eventSeq"], expected);
            }
            outgoing.sent(&packet, reliable);
        }
        let (packet, reliable) = outgoing.next().await.unwrap();
        assert!(!reliable);
        assert_eq!(text(&packet)["tick"], 100);
        outgoing.sent(&packet, reliable);
        assert_eq!(
            outbox.metrics.snapshots_replaced.load(Ordering::Relaxed),
            99
        );
        assert_eq!(outbox.metrics.snapshots_sent.load(Ordering::Relaxed), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), outgoing.next())
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn leave_and_rejoin_clear_previous_actor_state_before_new_generation() {
        let (outbox, mut outgoing) = channel();
        outbox.snapshot(json!({"type":"snapshot","lobbyId":"old","tick":999}).to_string());
        outbox.send(json!({"type":"left"}));
        outbox.send(json!({"type":"joined","lobbyId":"new"}));
        outbox.snapshot(json!({"type":"snapshot","lobbyId":"new","tick":3}).to_string());
        for kind in ["left", "joined", "snapshot"] {
            let (packet, reliable) = outgoing.next().await.unwrap();
            assert_eq!(text(&packet)["type"], kind);
            if kind == "snapshot" {
                assert_eq!(text(&packet)["lobbyId"], "new");
            }
            outgoing.sent(&packet, reliable);
        }
    }
    #[test]
    fn durable_event_bursts_are_bounded_and_preserve_every_event_once() {
        let mut sequence = 50;
        let batches = event_batches(
            "room",
            7,
            120,
            2.0,
            &mut sequence,
            (0..300)
                .map(|id| json!({"id":id,"roundNumber":6}))
                .collect(),
        );
        assert_eq!(batches.len(), 3);
        assert_eq!(sequence, 53);
        let mut ids = vec![];
        for (index, batch) in batches.iter().enumerate() {
            assert_eq!(batch["eventSeq"], 51 + index);
            assert_eq!(batch["roundNumber"], 7);
            let events = batch["events"].as_array().unwrap();
            assert!(events.len() <= 128);
            for event in events {
                assert_eq!(event["roundNumber"], 6);
                ids.push(event["id"].as_u64().unwrap());
            }
        }
        assert_eq!(ids, (0..300).collect::<Vec<_>>());
    }
    #[test]
    fn reliable_overflow_is_explicit_but_state_never_fills_reliable_capacity() {
        let (outbox, _outgoing) = channel_with_capacity(2);
        for _ in 0..1000 {
            assert!(outbox.snapshot("{}".into()));
        }
        assert!(outbox.send(json!({"event":1})));
        assert!(outbox.send(json!({"event":2})));
        assert!(!outbox.send(json!({"event":3})));
    }
    #[test]
    fn publication_clock_preserves_normal_cadence_and_never_catches_up_old_deadlines() {
        let start = Instant::now();
        let mut pace = SnapshotPacer::default();
        for frame in 1..=180 {
            let now = start + Duration::from_secs_f64(f64::from(frame) / 60.0);
            if frame % 3 == 0 {
                assert!(pace.ready(now), "normal 20 Hz state must remain eligible");
                pace.published(now);
                assert!(!pace.ready(now + Duration::from_millis(16)));
                assert!(!pace.ready(now + Duration::from_millis(33)));
            }
        }
        for pause in [101, 500] {
            let resumed = start + Duration::from_millis(4000 + pause);
            assert!(pace.ready(resumed));
            pace.published(resumed);
            for offset in [0, 1, 16, 33] {
                assert!(!pace.ready(resumed + Duration::from_millis(offset)));
            }
            assert!(pace.ready(resumed + Duration::from_millis(50)));
        }
    }
    #[tokio::test]
    async fn shared_fanout_serializes_lazily_once_without_publisher_lock() {
        let (first, mut first_rx) = channel();
        let (second, mut second_rx) = channel();
        let payload = WirePayload::value(json!({"type":"events","events":[{"type":"spawn"}]}));
        assert!(first.send_shared(payload.clone(), false));
        assert!(second.send_shared(payload.clone(), false));
        assert!(
            payload.encoded.get().is_none(),
            "publication must not serialize"
        );
        let (a, _) = first_rx.next().await.unwrap();
        let (b, _) = second_rx.next().await.unwrap();
        assert!(Arc::ptr_eq(&a.payload, &b.payload));
        assert!(
            payload.encoded.get().is_none(),
            "claiming must not serialize under a publisher lock"
        );
        // Holding both publishers cannot deadlock first-time serialization.
        let _first_lock = first.publisher.lock().unwrap();
        let _second_lock = second.publisher.lock().unwrap();
        assert!(std::ptr::eq(a.payload.message(), b.payload.message()));
        assert!(payload.encoded.get().is_some());
    }
    #[tokio::test]
    async fn stalled_writer_does_not_prevent_input_task_progress_or_shutdown() {
        use std::{
            pin::Pin,
            task::{Context, Poll},
        };
        struct Blocked;
        impl Sink<Message> for Blocked {
            type Error = std::io::Error;
            fn poll_ready(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Result<(), Self::Error>> {
                Poll::Pending
            }
            fn start_send(self: Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
                unreachable!()
            }
            fn poll_flush(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Result<(), Self::Error>> {
                Poll::Pending
            }
            fn poll_close(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Result<(), Self::Error>> {
                Poll::Pending
            }
        }
        let (outbox, outgoing) = channel();
        let (cancel, cancelled) = watch::channel(None);
        let writer = tokio::spawn(write_socket(Blocked, outgoing, cancelled));
        outbox.send(json!({"type":"welcome"}));
        tokio::task::yield_now().await;
        let (input, mut receive) = mpsc::channel(8);
        let reader = tokio::spawn(async move {
            let mut count = 0;
            while receive.recv().await.is_some() {
                count += 1;
            }
            count
        });
        for tick in 0..8 {
            input.send(tick).await.unwrap();
            outbox.snapshot(json!({"tick":tick}).to_string());
        }
        drop(input);
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), reader)
                .await
                .unwrap()
                .unwrap(),
            8
        );
        cancel.send(Some("session_replaced".into())).unwrap();
        tokio::time::timeout(Duration::from_millis(500), writer)
            .await
            .unwrap()
            .unwrap();
    }
}

#[cfg(test)]
mod hub_publication_tests {
    use super::*;
    use crate::{
        hub::{Config, Hub},
        sim::{Faction, InputFrame},
    };
    use serde_json::{Value, json};

    #[tokio::test]
    async fn coalesced_hub_snapshots_keep_shots_once_with_actor_generation_and_event_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let mut hub = Hub::new(Config {
            bind: "127.0.0.1:0".into(),
            database: directory.path().join("transport.sqlite"),
            origins: vec![],
            identity_salt: "transport-test-salt".into(),
            empty_seconds: 300.0,
            reconnect_seconds: 30.0,
            max_rooms: 1,
            proxy: false,
        })
        .unwrap();
        let (player, _) = hub.db.session(None).unwrap().unwrap();
        let cid = crate::db::id();
        let (outbox, mut outgoing) = channel();
        let (cancel, _cancelled) = watch::channel(None);
        hub.register(
            &player,
            cid.clone(),
            outbox.clone(),
            cancel,
            "loopback",
            "test",
        )
        .unwrap();
        hub.join(
            &player,
            &cid,
            None,
            "Transport tester",
            Faction::British,
            false,
        )
        .unwrap();
        let (joined, reliable) = outgoing.next().await.unwrap();
        outgoing.sent(&joined, reliable);
        let joined = joined.payload.named();
        let actor = joined["actorId"].as_u64().unwrap();
        let generation = joined["snapshot"]["actors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == actor)
            .unwrap()["spawnGeneration"]
            .as_u64()
            .unwrap();
        assert_eq!(joined["snapshot"]["inputTiming"], "tick-v2");
        assert_eq!(joined["snapshot"]["eventSeq"], 0);
        for _ in 0..40 {
            hub.tick().unwrap();
        }
        hub.input(
            &player,
            InputFrame {
                seq: 1,
                tick: Some(41),
                generation: Some(generation),
                fire: true,
                ..InputFrame::default()
            },
        );
        for _ in 40..120 {
            hub.tick().unwrap();
        }
        let mut previous_sequence = 0;
        let mut shots = 0;
        loop {
            let (packet, reliable) = tokio::time::timeout(Duration::from_secs(1), outgoing.next())
                .await
                .unwrap()
                .unwrap();
            outgoing.sent(&packet, reliable);
            let packet = packet.payload.named();
            if packet["type"] == "snapshot" {
                assert!(!reliable);
                assert_eq!(packet["events"], json!([]));
                assert_eq!(packet["tick"], 120);
                assert_eq!(packet["eventSeq"], previous_sequence);
                break;
            }
            assert!(reliable);
            assert!(packet["type"] == "events" || packet["type"] == "cues");
            if packet["type"] == "events" {
                let sequence = packet["eventSeq"].as_u64().unwrap();
                assert_eq!(sequence, previous_sequence + 1);
                previous_sequence = sequence;
                assert!(
                    !packet["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|event| event["type"] == "shot")
                );
            }
            for event in packet["events"].as_array().unwrap() {
                if event["type"] == "shot" && event["actor"] == actor {
                    assert_eq!(event["actorGeneration"], generation);
                    assert_eq!(event["seq"], 1);
                    assert_eq!(event["roundNumber"], joined["snapshot"]["roundNumber"]);
                    shots += 1;
                }
            }
        }
        assert_eq!(shots, 1);
        assert_eq!(
            outbox.metrics.snapshots_replaced.load(Ordering::Relaxed),
            39
        );
    }
    fn fixture() -> (tempfile::TempDir, Hub, String, Outbox, Outgoing, Value) {
        let directory = tempfile::tempdir().unwrap();
        let mut hub = Hub::new(Config {
            bind: "127.0.0.1:0".into(),
            database: directory.path().join("publication.sqlite"),
            origins: vec![],
            identity_salt: "publication-test-salt".into(),
            empty_seconds: 300.0,
            reconnect_seconds: 30.0,
            max_rooms: 1,
            proxy: false,
        })
        .unwrap();
        let (player, _) = hub.db.session(None).unwrap().unwrap();
        let cid = crate::db::id();
        let (outbox, mut outgoing) = channel();
        let (cancel, _) = watch::channel(None);
        hub.register(
            &player,
            cid.clone(),
            outbox.clone(),
            cancel,
            "loopback",
            "test",
        )
        .unwrap();
        hub.join(
            &player,
            &cid,
            None,
            "Transport tester",
            Faction::British,
            false,
        )
        .unwrap();
        let joined: Value = serde_json::from_str(&outgoing.try_recv().unwrap()).unwrap();
        (directory, hub, player, outbox, outgoing, joined)
    }
    #[tokio::test]
    async fn catchup_captures_only_the_latest_state_and_keeps_every_simulation_step() {
        let (_directory, mut hub, _player, outbox, mut outgoing, _joined) = fixture();
        for tick in 1..=8 {
            assert_eq!(hub.tick_with_publication(tick == 8).unwrap(), tick == 8);
        }
        assert_eq!(
            outbox.metrics.snapshots_published.load(Ordering::Relaxed),
            1
        );
        let packet = loop {
            let (packet, reliable) = outgoing.next().await.unwrap();
            outgoing.sent(&packet, reliable);
            if !reliable {
                break packet;
            }
        };
        assert_eq!(packet.payload.named()["tick"], 8);
        assert!((packet.payload.named()["time"].as_f64().unwrap() - 8.0 / 60.0).abs() < 1e-9);
        assert!(
            packet.payload.encoded.get().is_none(),
            "Hub snapshot capture must not encode"
        );
        assert!(matches!(packet.payload.message(), Message::Binary(_)));
        // Suppressing a second batch keeps its due state latched until pacing
        // permits publication; the eventual packet contains tick20, not tick18.
        for _ in 9..=19 {
            assert!(!hub.tick_with_publication(false).unwrap());
        }
        assert!(hub.tick_with_publication(true).unwrap());
        assert_eq!(
            outbox.metrics.snapshots_published.load(Ordering::Relaxed),
            2
        );
        let packet = loop {
            let (packet, reliable) = outgoing.next().await.unwrap();
            outgoing.sent(&packet, reliable);
            if !reliable {
                break packet;
            }
        };
        assert_eq!(packet.payload.named()["tick"], 20);
    }
    #[test]
    fn every_combat_tick_phase_emits_once_without_waiting_for_state_publication() {
        for target_tick in [40_u64, 41, 42] {
            let (_directory, mut hub, player, outbox, mut outgoing, joined) = fixture();
            for _ in 1..target_tick {
                hub.tick_with_publication(false).unwrap();
            }
            while outgoing.try_recv().is_ok() {}
            let actor_id = joined["actorId"].as_u64().unwrap();
            let generation = joined["snapshot"]["actors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|actor| actor["id"] == actor_id)
                .unwrap()["spawnGeneration"]
                .as_u64()
                .unwrap();
            hub.input(
                &player,
                InputFrame {
                    seq: 1,
                    tick: Some(target_tick),
                    generation: Some(generation),
                    fire: true,
                    ..InputFrame::default()
                },
            );
            hub.tick_with_publication(false).unwrap();
            let mut found = 0;
            while let Ok(raw) = outgoing.try_recv() {
                let packet: Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(packet["type"], "cues");
                for event in packet["events"].as_array().unwrap() {
                    if event["type"] == "shot" && event["actor"] == actor_id {
                        assert_eq!(packet["tick"], target_tick);
                        assert_eq!(event["tick"], target_tick);
                        assert_eq!(event["actorGeneration"], generation);
                        found += 1;
                    }
                }
            }
            assert_eq!(
                found,
                1,
                "phase {} must publish its shot immediately",
                target_tick % 3
            );
            assert_eq!(
                outbox.metrics.snapshots_published.load(Ordering::Relaxed),
                0
            );
            for _ in 0..3 {
                hub.tick().unwrap();
            }
            while let Ok(raw) = outgoing.try_recv() {
                let packet: Value = serde_json::from_str(&raw).unwrap();
                if packet["type"] == "events" {
                    assert!(
                        !packet["events"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|event| event["type"] == "shot")
                    );
                }
            }
        }
    }
}
