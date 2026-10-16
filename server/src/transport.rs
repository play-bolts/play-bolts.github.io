//! Bounded reliable traffic and replaceable state share a single socket writer.
//! Publishing never awaits the network, and the reader runs independently.
use axum::extract::ws::Message;
use futures_util::{Sink, SinkExt};
use serde_json::Value;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};

const RELIABLE_CAPACITY: usize = 128;
const SEND_TIMEOUT: Duration = Duration::from_secs(2);
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
#[derive(Clone)]
struct Packet {
    message: Message,
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
        self.send_text(
            value.to_string(),
            value["type"] == "joined" || value["type"] == "left",
        )
    }
    pub fn send_text(&self, text: String, reset_state: bool) -> bool {
        let mut publisher = self.publisher.lock().expect("outbox publisher");
        if reset_state {
            publisher.latest.send_replace(None);
        }
        Self::enqueue(&mut publisher, Message::Text(text.into()))
    }
    pub fn control(&self, message: Message) -> bool {
        Self::enqueue(
            &mut self.publisher.lock().expect("outbox publisher"),
            message,
        )
    }
    fn enqueue(publisher: &mut Publisher, message: Message) -> bool {
        let sequence = publisher.reliable_sequence + 1;
        if publisher
            .reliable
            .try_send(Packet {
                message,
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
    pub fn snapshot(&self, encoded: String) -> bool {
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
            message: Message::Text(encoded.into()),
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
        match packet.message {
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
            result = tokio::time::timeout(SEND_TIMEOUT, sink.send(packet.message.clone())) => result,
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
        if let Message::Text(text) = &packet.message {
            serde_json::from_str(text).unwrap()
        } else {
            panic!("expected text")
        }
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
        let Message::Text(joined) = joined.message else {
            panic!("joined text")
        };
        let joined: Value = serde_json::from_str(&joined).unwrap();
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
            let Message::Text(text) = packet.message else {
                panic!("text packet")
            };
            let packet: Value = serde_json::from_str(&text).unwrap();
            if packet["type"] == "snapshot" {
                assert!(!reliable);
                assert_eq!(packet["events"], json!([]));
                assert_eq!(packet["tick"], 120);
                assert_eq!(packet["eventSeq"], previous_sequence);
                break;
            }
            assert!(reliable);
            assert_eq!(packet["type"], "events");
            let sequence = packet["eventSeq"].as_u64().unwrap();
            assert_eq!(sequence, previous_sequence + 1);
            previous_sequence = sequence;
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
}
