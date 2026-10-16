use crate::transport::{Outbox, WirePayload};
use crate::{
    bots::{BotBrain, Navigation},
    db::{self, EventRow},
    sim::{self, Faction, InputFrame, Simulation},
    storage::Storage,
};
use hmac::{Hmac, Mac};
use rusqlite::params;
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub struct Config {
    pub bind: String,
    pub database: PathBuf,
    pub origins: Vec<String>,
    pub identity_salt: String,
    pub empty_seconds: f64,
    pub reconnect_seconds: f64,
    pub max_rooms: usize,
    pub proxy: bool,
}
impl Config {
    pub fn from_env() -> Result<Self, String> {
        let env = |key: &str, default: &str| std::env::var(key).unwrap_or_else(|_| default.into());
        let bind = env("BOLTS_BIND", "127.0.0.1:8080");
        let identity_salt = env("BOLTS_IDENTITY_SALT", "");
        if !bind.starts_with("127.0.0.1:") && identity_salt.len() < 32 {
            return Err(
                "BOLTS_IDENTITY_SALT must have at least32characters on public binds".into(),
            );
        }
        Ok(Self {
            bind,
            database: env("BOLTS_DB", "data/bolts.sqlite").into(),
            origins: env(
                "BOLTS_ORIGINS",
                "http://127.0.0.1:5173,http://localhost:5173",
            )
            .split(',')
            .map(str::to_owned)
            .collect(),
            identity_salt: if identity_salt.is_empty() {
                db::id()
            } else {
                identity_salt
            },
            empty_seconds: env("BOLTS_EMPTY_SECONDS", "300")
                .parse()
                .map_err(|_| "Invalid empty timeout")?,
            reconnect_seconds: env("BOLTS_RECONNECT_SECONDS", "30")
                .parse()
                .map_err(|_| "Invalid reconnect timeout")?,
            max_rooms: env("BOLTS_MAX_ROOMS", "32")
                .parse()
                .map_err(|_| "Invalid room limit")?,
            proxy: env("BOLTS_TRUST_PROXY", "false") == "true",
        })
    }
}
pub struct Endpoint {
    pub cid: String,
    pub tx: Outbox,
    pub cancel: watch::Sender<Option<String>>,
    latency: Latency,
}
const PING_STALE: Duration = Duration::from_secs(10);
#[derive(Default)]
struct Latency {
    pending: Option<([u8; 16], Instant)>,
    sample: Option<(u16, Instant)>,
}
impl Latency {
    fn challenge(&mut self, now: Instant) -> Option<Vec<u8>> {
        if self
            .pending
            .is_some_and(|(_, sent)| now.saturating_duration_since(sent) < PING_STALE)
        {
            return None;
        }
        let nonce = *uuid::Uuid::new_v4().as_bytes();
        self.pending = Some((nonce, now));
        Some(nonce.to_vec())
    }
    fn reply(&mut self, nonce: &[u8], now: Instant) {
        let Some((expected, sent)) = self.pending else {
            return;
        };
        if nonce != expected {
            return;
        }
        self.pending = None;
        let elapsed = now.saturating_duration_since(sent);
        if elapsed < PING_STALE {
            self.sample = Some((elapsed.as_millis().min(999) as u16, now));
        }
    }
    fn value(&self, now: Instant) -> Option<u16> {
        self.sample
            .filter(|(_, received)| now.saturating_duration_since(*received) < PING_STALE)
            .map(|(ms, _)| ms)
    }
}
struct Member {
    actor: u32,
    bot: Option<BotBrain>,
    membership: String,
    disconnected: Option<Instant>,
    chat: VecDeque<Instant>,
    // A player can leave and rejoin the same round with a new actor. Keep
    // previous participation in the persisted match totals.
    stats_game: String,
    stats_before_join: [i64; 4],
}
struct Room {
    id: String,
    name: String,
    game: String,
    sim: Simulation,
    members: HashMap<String, Member>,
    next_actor: u32,
    empty_since: Option<Instant>,
    ended_since: Option<Instant>,
    pending: Vec<Value>,
    event_seq: u64,
    cue_seq: u64,
    cues: Vec<Value>,
    snapshot_due: bool,
    navigation: Navigation,
    participation: HashMap<String, [i64; 4]>,
    durable_pending: VecDeque<(u64, Value)>,
    durable_chat: VecDeque<(u64, Value)>,
}
impl Room {
    fn human_seats(&self) -> usize {
        self.members.values().filter(|m| m.bot.is_none()).count()
    }
    fn online_humans(&self, connections: &HashMap<String, Endpoint>) -> usize {
        self.members
            .iter()
            .filter(|(player, m)| {
                m.bot.is_none() && m.disconnected.is_none() && connections.contains_key(*player)
            })
            .count()
    }
    fn snapshot(&self, connections: &HashMap<String, Endpoint>) -> crate::codec::Snapshot {
        let now = Instant::now();
        let actors = self
            .sim
            .actors
            .iter()
            .map(|actor| {
                let member = self
                    .members
                    .iter()
                    .find(|(_, member)| member.actor == actor.id);
                crate::codec::SnapshotActor {
                    actor: actor.clone(),
                    bot: member.is_some_and(|(_, member)| member.bot.is_some()),
                    ping: member
                        .and_then(|(player, _)| connections.get(player))
                        .and_then(|endpoint| endpoint.latency.value(now)),
                    input_timing: self.sim.input_timing(actor.id),
                }
            })
            .collect();
        crate::codec::Snapshot {
            lobby_id: self.id.clone(),
            event_seq: self.event_seq,
            tick: self.sim.tick_number,
            time: self.sim.time,
            remaining: self.sim.remaining,
            round_number: self.sim.round_number,
            ended: self.sim.ended,
            winner: self.sim.winner,
            actors,
        }
    }
}
pub struct Hub {
    pub config: Config,
    pub db: Storage,
    rooms: HashMap<String, Room>,
    pub connections: HashMap<String, Endpoint>,
    pub failed: bool,
    pub shutting_down: bool,
    rate: HashMap<String, VecDeque<Instant>>,
    name_index: usize,
    pub internal_token: Option<String>,
    pub managed_lobby: Option<String>,
}
pub type HResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
impl Hub {
    pub fn new(config: Config) -> HResult<Self> {
        let db = Storage::open(&config.database)?;
        Ok(Self {
            config,
            db,
            rooms: HashMap::new(),
            connections: HashMap::new(),
            failed: false,
            shutting_down: false,
            rate: HashMap::new(),
            name_index: 0,
            internal_token: None,
            managed_lobby: None,
        })
    }
    pub fn fingerprint(&self, value: &str) -> String {
        let mut h =
            Hmac::<Sha256>::new_from_slice(self.config.identity_salt.as_bytes()).expect("HMAC key");
        h.update(value.as_bytes());
        format!("{:x}", h.finalize().into_bytes())
    }
    pub fn allowed_origin(&self, origin: Option<&str>) -> bool {
        origin.is_none_or(|origin| self.config.origins.iter().any(|allowed| allowed == origin))
    }
    pub fn allow(&mut self, key: String, limit: usize, seconds: u64) -> bool {
        if self.rate.len() > 10000 {
            self.rate.retain(|_, v| {
                v.back()
                    .is_some_and(|t| t.elapsed() < Duration::from_secs(60))
            });
            if self.rate.len() > 10000 {
                return false;
            }
        }
        let times = self.rate.entry(key).or_default();
        while times
            .front()
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(seconds))
        {
            times.pop_front();
        }
        if times.len() >= limit {
            return false;
        }
        times.push_back(Instant::now());
        true
    }
    pub fn send(&self, player: &str, message: Value) {
        if let Some(e) = self.connections.get(player)
            && !e.tx.send(message)
        {
            let _ = e.cancel.send(Some("slow_consumer".into()));
        }
    }
    fn broadcast(&self, room: &Room, message: Value) {
        let payload = WirePayload::value(message);
        for player in room.members.keys() {
            if let Some(e) = self.connections.get(player)
                && !e.tx.send_shared(payload.clone(), false)
            {
                let _ = e.cancel.send(Some("slow_consumer".into()));
            }
        }
    }
    pub fn register(
        &mut self,
        player: &str,
        cid: String,
        tx: Outbox,
        cancel: watch::Sender<Option<String>>,
        ip: &str,
        ua: &str,
    ) -> HResult<()> {
        if self.shutting_down { return Err("server_busy".into()); }
        if let Some(old) = self.connections.remove(player) {
            let _ = old
                .tx
                .send(error("session_replaced", "Connected in another tab."));
            let _ = old.cancel.send(Some("session_replaced".into()));
            self.db.disconnect(&old.cid, "session_replaced")?;
        }
        self.db
            .connect(&cid, player, &self.fingerprint(ip), &self.fingerprint(ua))?;
        self.connections.insert(
            player.into(),
            Endpoint {
                cid,
                tx,
                cancel,
                latency: Latency::default(),
            },
        );
        Ok(())
    }
    /// Only transport control replies to an outstanding random server challenge
    /// can produce scoreboard latency. Client JSON ping numbers are never used.
    pub fn ping(&mut self, player: &str, cid: &str, now: Instant) -> Option<Vec<u8>> {
        self.connections
            .get_mut(player)
            .filter(|endpoint| endpoint.cid == cid)
            .and_then(|endpoint| endpoint.latency.challenge(now))
    }
    pub fn pong(&mut self, player: &str, cid: &str, nonce: &[u8], now: Instant) {
        if let Some(endpoint) = self
            .connections
            .get_mut(player)
            .filter(|endpoint| endpoint.cid == cid)
        {
            endpoint.latency.reply(nonce, now);
        }
    }
    pub fn disconnected(&mut self, player: &str, cid: &str) -> HResult<()> {
        if !self.connections.get(player).is_some_and(|e| e.cid == cid) {
            return Ok(());
        }
        self.connections.remove(player);
        self.db.disconnect(cid, "disconnected")?;
        for room in self.rooms.values_mut() {
            if let Some(member) = room.members.get_mut(player) {
                member.disconnected = Some(Instant::now());
                room.sim.neutralize(member.actor);
                reconcile_bots(&mut self.db, room, &self.connections)?;
            }
        }
        Ok(())
    }
    fn create_room(&mut self) -> HResult<String> {
        if self.managed_lobby.is_some() || self.rooms.len() >= self.config.max_rooms {
            return Err("server_busy".into());
        }
        const GENERALS: [&str; 6] = [
            "Rommel",
            "Guderian",
            "Moltke",
            "Blücher",
            "Scharnhorst",
            "Clausewitz",
        ];
        const GREEK: [&str; 24] = [
            "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa",
            "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon", "Phi",
            "Chi", "Psi", "Omega",
        ];
        let name = loop {
            let n = self.name_index;
            self.name_index += 1;
            let name = format!(
                "{} {}{}",
                GENERALS[(n / 24) % 6],
                GREEK[n % 24],
                if n >= 144 {
                    format!(" {}", n / 144 + 1)
                } else {
                    String::new()
                }
            );
            if self.rooms.values().all(|r| r.name != name) {
                break name;
            }
        };
        self.create_named_room(db::id(), name)
    }
    fn create_named_room(&mut self, id: String, name: String) -> HResult<String> {
        let game = db::id();
        let seed = u32::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..4].try_into().unwrap());
        let sim = Simulation::new(seed);
        let navigation = Navigation::new(&sim);
        self.db.create_lobby(&id, &name)?;
        self.db.create_match(&game, &id, sim.round_number)?;
        self.rooms.insert(
            id.clone(),
            Room {
                id: id.clone(),
                name,
                game,
                sim,
                members: HashMap::new(),
                next_actor: 1,
                empty_since: Some(Instant::now()),
                ended_since: None,
                pending: vec![],
                event_seq: 0,
                cue_seq: 0,
                cues: vec![],
                snapshot_due: false,
                navigation,
                participation: HashMap::new(),
                durable_pending: VecDeque::new(),
                durable_chat: VecDeque::new(),
            },
        );
        Ok(id)
    }
    /// A managed process owns exactly one GameLift session, including its rounds.
    pub fn activate_managed(&mut self, id: &str, name: &str) -> HResult<()> {
        if self.shutting_down { return Err("server_busy".into()); }
        if self.managed_lobby.as_deref() == Some(id) {
            return Ok(());
        }
        if self.managed_lobby.is_some() || !self.rooms.is_empty() || id.is_empty() || id.len() > 512
        {
            return Err("invalid managed session".into());
        }
        self.create_named_room(id.to_owned(), sanitize_name(name))?;
        self.managed_lobby = Some(id.to_owned());
        self.config.max_rooms = 1;
        Ok(())
    }
    pub fn managed_status(&self) -> Value {
        json!({"ok": !self.failed, "active": self.managed_lobby.as_ref().is_some_and(|id| self.rooms.contains_key(id)), "players": self.online_count()})
    }
    pub fn lobbies(&mut self) -> HResult<Value> {
        if self.shutting_down { return Err("server_busy".into()); }
        if !self
            .rooms
            .values()
            .any(|r| r.human_seats() < sim::MAX_PLAYERS)
            && self.rooms.len() < self.config.max_rooms
        {
            self.create_room()?;
        }
        let mut list:Vec<_>=self.rooms.values().map(|r|json!({"id":r.id,"name":r.name,"players":r.human_seats(),"bots":r.members.len()-r.human_seats(),"capacity":sim::MAX_PLAYERS,"phase":if r.sim.ended{"ended"}else{"playing"}})).collect();
        list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(json!({"version":1,"lobbies":list}))
    }
    pub fn online_count(&self) -> usize {
        self.rooms
            .values()
            .map(|r| r.online_humans(&self.connections))
            .sum()
    }
    pub fn join(
        &mut self,
        player: &str,
        cid: &str,
        lobby: Option<&str>,
        name: &str,
        faction: Faction,
        spectator: bool,
    ) -> HResult<()> {
        if self.shutting_down {
            return Err("server_busy".into());
        }
        if let Some(room) = self
            .rooms
            .values_mut()
            .find(|r| r.members.contains_key(player))
            && (lobby.is_none() || lobby == Some(room.id.as_str()))
        {
            let member = room.members.get_mut(player).unwrap();
            member.disconnected = None;
            room.sim.reset_input_stream(member.actor);
            let actor = member.actor;
            reconcile_bots(&mut self.db, room, &self.connections)?;
            self.db.event(EventRow {
                kind: "player_reconnect",
                lobby: Some(&room.id),
                game: Some(&room.game),
                connection: Some(cid),
                actor: Some(player),
                target: None,
                data: json!({"actorId":actor}),
            })?;
            let payload = WirePayload::joined(
                room.name.clone(),
                actor,
                room.cue_seq,
                room.snapshot(&self.connections),
            );
            if let Some(endpoint) = self.connections.get(player) {
                if !endpoint.tx.send_shared(payload, true) {
                    let _ = endpoint.cancel.send(Some("slow_consumer".into()));
                }
            }
            return Ok(());
        }
        // Validate the destination before giving up an existing seat.
        let roomid = if let Some(lobby) = lobby {
            let r = self.rooms.get(lobby).ok_or("lobby_missing")?;
            if r.human_seats() >= sim::MAX_PLAYERS {
                return Err("lobby_full".into());
            }
            lobby.to_owned()
        } else if let Some(r) = self
            .rooms
            .values()
            .filter(|r| r.human_seats() < sim::MAX_PLAYERS)
            .max_by_key(|r| r.human_seats())
        {
            r.id.clone()
        } else {
            self.create_room()?
        };
        self.leave(player, "switch_lobby", false)?;
        let room = self.rooms.get_mut(&roomid).unwrap();
        // A human may always take a seat held by a bot. Retained human seats
        // during reconnect grace have priority over temporary AI as well.
        while room.members.len() >= sim::MAX_PLAYERS {
            remove_one_bot(&mut self.db, room, "human_priority")?;
        }
        let actor = room.next_actor;
        room.next_actor += 1;
        let name = sanitize_name(name);
        let membership = db::id();
        room.sim
            .join_participant(actor, name.clone(), faction, spectator)
            .map_err(|e| e.to_string())?;
        let faction_text = serde_json::to_value(faction)?.as_str().unwrap().to_owned();
        self.db.join(
            &membership,
            &room.id,
            &room.game,
            player,
            actor,
            &name,
            &faction_text,
            cid,
            spectator,
        )?;
        let stats_before_join = room.participation.get(player).copied().unwrap_or([0; 4]);
        room.members.insert(
            player.into(),
            Member {
                actor,
                bot: None,
                membership,
                disconnected: None,
                chat: VecDeque::new(),
                stats_game: room.game.clone(),
                stats_before_join,
            },
        );
        room.empty_since = None;
        reconcile_bots(&mut self.db, room, &self.connections)?;
        let payload = WirePayload::joined(
            room.name.clone(),
            actor,
            room.cue_seq,
            room.snapshot(&self.connections),
        );
        if let Some(endpoint) = self.connections.get(player) {
            if !endpoint.tx.send_shared(payload, true) {
                let _ = endpoint.cancel.send(Some("slow_consumer".into()));
            }
        }
        Ok(())
    }
    pub fn leave(&mut self, player: &str, reason: &str, notify: bool) -> HResult<()> {
        for room in self.rooms.values_mut() {
            if let Some(member) = room.members.get(player) {
                sync_stats(&self.db, room)?;
                self.db
                    .leave(&member.membership, &room.id, &room.game, player, reason)?;
                let actor = member.actor;
                remember_stats(room, player);
                room.members.remove(player);
                room.sim.leave(actor);
                if reason != "server_stop" {
                    reconcile_bots(&mut self.db, room, &self.connections)?;
                }
                if room.human_seats() == 0 {
                    room.empty_since = Some(Instant::now());
                }
            }
        }
        if notify {
            self.send(player, json!({"type":"left"}));
        }
        Ok(())
    }
    pub fn input(&mut self, player: &str, input: InputFrame) {
        if self.shutting_down { return; }
        if let Some(room) = self
            .rooms
            .values_mut()
            .find(|r| r.members.contains_key(player))
        {
            let member = &room.members[player];
            room.sim.submit_input(member.actor, input);
        }
    }
    pub fn chat(&mut self, player: &str, cid: &str, text: &str) -> HResult<()> {
        if self.shutting_down { return Err("server_busy".into()); }
        let text: String = text.chars().filter(|c| !c.is_control()).take(257).collect();
        let text = text.trim();
        if text.is_empty() || text.chars().count() > 256 {
            return Err("invalid_message".into());
        }
        let room = self
            .rooms
            .values_mut()
            .find(|r| r.members.contains_key(player))
            .ok_or("not_joined")?;
        let member = room.members.get_mut(player).unwrap();
        while member
            .chat
            .front()
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(5))
        {
            member.chat.pop_front();
        }
        if member.chat.len() >= 3 {
            return Err("rate_limited".into());
        }
        member.chat.push_back(Instant::now());
        let actor = member.actor;
        let name = room.sim.actor(actor).ok_or("not_joined")?.name.clone();
        let (ticket, eid, at) = self
            .db
            .chat(&room.id, &room.game, player, cid, &name, text)?;
        let msg = json!({"type":"chat","id":eid,"actorId":actor,"name":name,"text":text,"at":at});
        if room.durable_chat.len() >= 128 { return Err("durable chat backlog exhausted".into()); }
        room.durable_chat.push_back((ticket, msg));
        Ok(())
    }
    pub fn profile(&mut self, player: &str, name: &str) -> HResult<()> {
        if self.shutting_down { return Err("server_busy".into()); }
        let name = sanitize_name(name);
        if let Some(room) = self
            .rooms
            .values_mut()
            .find(|r| r.members.contains_key(player))
        {
            let actor = room.members[player].actor;
            if let Some(a) = room.sim.actor_mut(actor) {
                if a.name == name {
                    return Ok(());
                }
                a.name = name.clone();
            }
            self.db.event(EventRow {
                kind: "profile_change",
                lobby: Some(&room.id),
                game: Some(&room.game),
                connection: None,
                actor: Some(player),
                target: None,
                data: json!({"name":name}),
            })?;
            sync_stats(&self.db, room)?;
        }
        self.db.set_name(player, &name)?;
        Ok(())
    }
    pub fn loadout(&mut self, player: &str, faction: Faction) -> HResult<()> {
        if self.shutting_down { return Err("server_busy".into()); }
        if let Some(room) = self
            .rooms
            .values_mut()
            .find(|r| r.members.contains_key(player))
        {
            let actor = room.members[player].actor;
            if !room.sim.change_faction(actor, faction) {
                return Ok(());
            }
            record_sim_events(&mut self.db, room)?;
            self.db.event(EventRow {
                kind: "loadout_change",
                lobby: Some(&room.id),
                game: Some(&room.game),
                connection: None,
                actor: Some(player),
                target: None,
                data: json!({"faction":faction,"spectator":false}),
            })?;
            sync_stats(&self.db, room)?;
        }
        Ok(())
    }

    pub fn spectate(&mut self, player: &str) -> HResult<()> {
        if self.shutting_down { return Err("server_busy".into()); }
        let room = self
            .rooms
            .values_mut()
            .find(|r| r.members.contains_key(player))
            .ok_or("not_joined")?;
        let actor = room.members[player].actor;
        if room.sim.spectate(actor) {
            self.db.event(EventRow {
                kind: "loadout_change",
                lobby: Some(&room.id),
                game: Some(&room.game),
                connection: None,
                actor: Some(player),
                target: None,
                data: json!({"faction":room.sim.actor(actor).unwrap().faction,"spectator":true}),
            })?;
            sync_stats(&self.db, room)?;
        }
        Ok(())
    }
    pub fn tick(&mut self) -> HResult<()> {
        self.tick_with_publication(true).map(|_| ())
    }
    /// Execute every authoritative step, but capture a due snapshot only at the
    /// end of the caller's catch-up batch. Due state survives suppressed steps.
    pub fn tick_with_publication(&mut self, publish_snapshot: bool) -> HResult<bool> {
        if self.shutting_down {
            return Ok(false);
        }
        self.db.check()?;
        let committed = self.db.committed();
        let expired: Vec<_> = self
            .rooms
            .values()
            .flat_map(|r| {
                r.members
                    .iter()
                    .filter(|(_, m)| {
                        m.disconnected.is_some_and(|t| {
                            t.elapsed().as_secs_f64() > self.config.reconnect_seconds
                        })
                    })
                    .map(|(p, _)| p.clone())
            })
            .collect();
        for p in expired {
            self.leave(&p, "timeout", false)?;
        }
        let mut packets = vec![];
        let mut cues = vec![];
        let mut chats = vec![];
        let mut closed = vec![];
        for room in self.rooms.values_mut() {
            while room
                .durable_pending
                .front()
                .is_some_and(|(ticket, _)| *ticket <= committed)
            {
                room.pending
                    .push(room.durable_pending.pop_front().unwrap().1);
            }
            while room
                .durable_chat
                .front()
                .is_some_and(|(ticket, _)| *ticket <= committed)
            {
                chats.push((room.id.clone(), room.durable_chat.pop_front().unwrap().1));
            }
            if room.members.is_empty() {
                if room
                    .empty_since
                    .is_some_and(|t| t.elapsed().as_secs_f64() > self.config.empty_seconds)
                {
                    closed.push(room.id.clone());
                }
                continue;
            }
            for member in room.members.values_mut() {
                if let Some(brain) = &mut member.bot {
                    let input = brain.input(&room.sim, &room.navigation, member.actor);
                    room.sim.submit_input(member.actor, input);
                }
            }
            room.sim.tick(sim::TICK_SECONDS);
            record_sim_events(&mut self.db, room)?;
            let committed = self.db.committed();
            while room
                .durable_pending
                .front()
                .is_some_and(|(ticket, _)| *ticket <= committed)
            {
                room.pending
                    .push(room.durable_pending.pop_front().unwrap().1);
            }
            if room.sim.ended && room.ended_since.is_none() {
                room.ended_since = Some(Instant::now());
                let winner = room
                    .members
                    .iter()
                    .find(|(_, m)| Some(m.actor) == room.sim.winner)
                    .map(|(p, _)| p.as_str());
                sync_stats(&self.db, room)?;
                self.db.execute("UPDATE matches SET ended_at=?1,end_reason='time_limit',winner_player_id=?2 WHERE id=?3",vec![db::now_ms().into(),winner.map(str::to_owned).into(),room.game.clone().into()])?;
                self.db.event(EventRow {
                    kind: "round_end",
                    lobby: Some(&room.id),
                    game: Some(&room.game),
                    connection: None,
                    actor: winner,
                    target: None,
                    data: json!({"roundNumber":room.sim.round_number}),
                })?;
            }
            if room
                .ended_since
                .is_some_and(|t| t.elapsed() > Duration::from_secs(8))
            {
                room.participation.clear();
                room.sim.restart_round();
                room.ended_since = None;
                room.game = db::id();
                self.db
                    .create_match(&room.game, &room.id, room.sim.round_number)?;
                sync_stats(&self.db, room)?;
            }
            if !room.cues.is_empty() {
                for events in std::mem::take(&mut room.cues).chunks(128) {
                    room.cue_seq += 1;
                    cues.push((room.id.clone(), json!({"type":"cues","lobbyId":room.id,
                        "roundNumber":room.sim.round_number,"tick":room.sim.tick_number,"time":room.sim.time,
                        "cueSeq":room.cue_seq,"events":events})));
                }
            }
            room.snapshot_due |= room.sim.tick_number % 3 == 0;
            if publish_snapshot && room.snapshot_due {
                room.snapshot_due = false;
                let events = crate::transport::event_batches(
                    &room.id,
                    room.sim.round_number,
                    room.sim.tick_number,
                    room.sim.time,
                    &mut room.event_seq,
                    std::mem::take(&mut room.pending),
                );
                packets.push((room.id.clone(), events, room.snapshot(&self.connections)));
            }
        }
        for (id, message) in chats.into_iter().chain(cues) {
            self.broadcast(&self.rooms[&id], message);
        }
        let published = !packets.is_empty();
        for (id, events, packet) in packets {
            let room = &self.rooms[&id];
            for events in events {
                self.broadcast(room, events);
            }
            let payload = WirePayload::snapshot(packet);
            for player in room.members.keys() {
                if let Some(endpoint) = self.connections.get(player) {
                    if !endpoint.tx.snapshot_shared(payload.clone()) {
                        let _ = endpoint.cancel.send(Some("slow_consumer".into()));
                    }
                }
            }
        }
        for id in closed {
            self.close_room(&id, "inactive")?;
        }
        Ok(published)
    }
    fn close_room(&mut self, id: &str, reason: &str) -> HResult<()> {
        if let Some(room) = self.rooms.remove(id) {
            let at = db::now_ms();
            self.db.execute(
                "UPDATE lobbies SET closed_at=?1,close_reason=?2 WHERE id=?3",
                vec![at.into(), reason.to_owned().into(), id.to_owned().into()],
            )?;
            self.db.execute(
                "UPDATE matches SET ended_at=?1,end_reason=?2 WHERE id=?3 AND ended_at IS NULL",
                vec![at.into(), reason.to_owned().into(), room.game.into()],
            )?;
        }
        Ok(())
    }
    pub fn fail(&mut self) {
        self.failed = true;
        for e in self.connections.values() {
            let _ =
                e.tx.send(error("server_busy", "Server unavailable."));
            let _ = e.cancel.send(Some("server_busy".into()));
        }
    }
    pub fn shutdown(&mut self) -> HResult<()> {
        if self.shutting_down { return Ok(()); }
        self.shutting_down = true;
        let mut players: Vec<_> = self.connections.keys().cloned().collect();
        players.extend(self.rooms.values().flat_map(|r| r.members.keys().cloned()));
        players.sort();
        players.dedup();
        for player in players {
            self.leave(&player, "server_stop", false)?;
            if let Some(e) = self.connections.remove(&player) {
                self.db.disconnect(&e.cid, "server_stop")?;
                let _ = e.cancel.send(Some("server_stop".into()));
            }
        }
        let rooms: Vec<_> = self.rooms.keys().cloned().collect();
        for room in rooms {
            self.close_room(&room, "server_stop")?;
        }
        self.db.event(EventRow {
            kind: "server_stop",
            lobby: None,
            game: None,
            connection: None,
            actor: None,
            target: None,
            data: json!({}),
        })?;
        // The caller drains/checkpoints Storage outside the simulation mutex.
        Ok(())
    }
}
/// Two AI accompany one or two connected humans. Spectators are humans for
/// this threshold; reconnect reservations are not. Bots never consume a seat
/// ahead of a human, and zero connected humans removes every bot immediately.
fn reconcile_bots(
    db: &Storage,
    room: &mut Room,
    connections: &HashMap<String, Endpoint>,
) -> HResult<()> {
    let online = room.online_humans(connections);
    let wanted = if (1..3).contains(&online) {
        2.min(sim::MAX_PLAYERS.saturating_sub(room.human_seats()))
    } else {
        0
    };
    while room.members.len() - room.human_seats() > wanted {
        remove_one_bot(
            db,
            room,
            if online >= 3 {
                "human_priority"
            } else {
                "lobby_idle"
            },
        )?;
    }
    for slot in 0..2 {
        if room.members.len() - room.human_seats() >= wanted {
            break;
        }
        let name = if slot == 0 {
            "[AI] Volkov"
        } else {
            "[AI] Weber"
        };
        let player = db.ensure_bot(&format!("{}:{slot}", room.id), name)?;
        if room.members.contains_key(&player) {
            continue;
        }
        let actor = room.next_actor;
        room.next_actor += 1;
        let faction = if slot == 0 {
            Faction::Russian
        } else {
            Faction::German
        };
        let membership = db::id();
        room.sim
            .join(actor, name.into(), faction)
            .map_err(str::to_owned)?;
        db.join_bot(
            &membership,
            &room.id,
            &room.game,
            &player,
            actor,
            name,
            if slot == 0 { "russian" } else { "german" },
        )?;
        let stats_before_join = room.participation.get(&player).copied().unwrap_or([0; 4]);
        room.members.insert(
            player,
            Member {
                actor,
                bot: Some(BotBrain::new(
                    actor.wrapping_mul(19417) ^ room.sim.tick_number as u32,
                )),
                membership,
                disconnected: None,
                chat: VecDeque::new(),
                stats_game: room.game.clone(),
                stats_before_join,
            },
        );
    }
    Ok(())
}

fn remove_one_bot(db: &Storage, room: &mut Room, reason: &str) -> HResult<()> {
    let player = room
        .members
        .iter()
        .filter(|(_, m)| m.bot.is_some())
        .max_by_key(|(_, m)| m.actor)
        .map(|(p, _)| p.clone())
        .ok_or("no_bot_seat")?;
    record_sim_events(db, room)?;
    sync_stats(db, room)?;
    let member = &room.members[&player];
    db.leave(&member.membership, &room.id, &room.game, &player, reason)?;
    let actor = member.actor;
    remember_stats(room, &player);
    room.sim.leave(actor);
    room.members.remove(&player);
    Ok(())
}

fn totals(room: &Room, player: &str) -> [i64; 4] {
    let m = &room.members[player];
    let before = if m.stats_game == room.game { m.stats_before_join } else { [0; 4] };
    room.sim.actor(m.actor).map(|a| [before[0]+i64::from(a.kills),before[1]+i64::from(a.deaths),before[2]+i64::from(a.shots),before[3]+i64::from(a.hits)]).unwrap_or(before)
}
fn remember_stats(room: &mut Room, player: &str) {
    room.participation.insert(player.to_owned(), totals(room, player));
}
fn sync_stats(db: &Storage, room: &Room) -> HResult<()> {
    let game = room.game.clone();
    let at = db::now_ms();
    let rows = room.members.iter().filter_map(|(player,m)| room.sim.actor(m.actor).map(|a| (player.clone(),a.name.clone(),a.faction,totals(room,player)))).collect::<Vec<_>>();
    db.write(move |db| {
        let tx = db.conn.transaction()?;
        for (player,name,faction,stats) in rows {
            let faction=serde_json::to_value(faction)?;
            tx.execute("INSERT INTO match_players(match_id,player_id,name,faction,joined_at,kills,deaths,shots,hits) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(match_id,player_id) DO UPDATE SET name=excluded.name,faction=excluded.faction,kills=excluded.kills,deaths=excluded.deaths,shots=excluded.shots,hits=excluded.hits",params![game,player,name,faction.as_str(),at,stats[0],stats[1],stats[2],stats[3]])?;
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(())
}
pub fn error(code: &str, message: &str) -> Value {
    json!({"type":"error","code":code,"message":message})
}
pub fn sanitize_name(name: &str) -> String {
    sim::sanitize_name(name)
}

fn record_sim_events(db: &Storage, room: &mut Room) -> HResult<()> {
    for event in room.sim.drain_events() {
        let mut ticket = None;
        if event.kind == "kill"
            && let Some(victim) = event.victim
        {
            let killer = room
                .members
                .iter()
                .find(|(_, m)| m.actor == event.actor)
                .map(|(p, _)| p.as_str());
            let victim = room
                .members
                .iter()
                .find(|(_, m)| m.actor == victim)
                .map(|(p, _)| p.as_str());
            if let (Some(k), Some(v)) = (killer, victim) {
                ticket = Some(db.kill(
                    &room.id,
                    &room.game,
                    k,
                    v,
                    event.weapon.as_deref().unwrap_or("rifle"),
                    event.headshot.unwrap_or(false),
                    json!({"serverTime":room.sim.time,"event":event}),
                )?);
                sync_stats(db, room)?;
            }
        }
        let wire = wire_sim_event(&room.sim, &event)?;
        // Cosmetic combat cues are self-contained and generation-qualified.
        // They need neither a future snapshot nor a durable kill's disk commit.
        if matches!(
            event.kind.as_str(),
            "shot" | "hurt" | "reload" | "bolt" | "switch"
        ) {
            room.cues.push(wire);
            continue;
        }
        // Lifecycle events cannot overtake an uncommitted kill. Other rooms
        // continue independently; the simulation itself never waits for disk.
        let ticket = ticket
            .unwrap_or(0)
            .max(room.durable_pending.back().map_or(0, |(ticket, _)| *ticket));
        if room.durable_pending.len() >= 512 {
            return Err("durable event backlog exhausted".into());
        }
        room.durable_pending.push_back((ticket, wire));
    }
    Ok(())
}

/// Absent optional event metadata is omitted, matching the strict browser wire
/// contract. Explicit null would invalidate the entire reliable event batch.
fn wire_sim_event(sim: &Simulation, event: &sim::GameEvent) -> HResult<Value> {
    let mut wire = serde_json::to_value(event)?;
    if let Some(actor) = sim.actor(event.actor) {
        wire["actorName"] = json!(actor.name);
        wire["actorFaction"] = json!(actor.faction);
        wire["actorGeneration"] = json!(actor.spawn_generation);
        if event.kind == "hurt" {
            // A prompt damage cue can arrive before the death snapshot. Keep
            // the existing lethal flash without granting the cue HP authority.
            wire["lethal"] = json!(!actor.alive);
        }
    }
    if let Some(victim) = event.victim.and_then(|id| sim.actor(id)) {
        wire["victimName"] = json!(victim.name);
        wire["victimGeneration"] = json!(victim.spawn_generation);
    }
    if let Some(hit) = event
        .shot
        .as_ref()
        .and_then(|shot| shot.hit)
        .and_then(|id| sim.actor(id))
    {
        wire["hitGeneration"] = json!(hit.spawn_generation);
    }
    wire["roundNumber"] = json!(sim.round_number);
    wire["tick"] = json!(sim.tick_number);
    wire["time"] = json!(sim.time);
    Ok(wire)
}

#[cfg(test)]
mod event_metadata_tests {
    use super::*;

    #[test]
    fn damage_cue_carries_authoritative_lethality_before_the_next_snapshot() {
        let mut sim = Simulation::new(51235);
        sim.join(42, "Damage test".into(), Faction::British).unwrap();
        let event: sim::GameEvent = serde_json::from_value(json!({
            "type":"hurt", "actor":42, "value":100
        })).unwrap();
        assert_eq!(wire_sim_event(&sim, &event).unwrap()["lethal"], false);
        sim.actor_mut(42).unwrap().alive = false;
        let cue = wire_sim_event(&sim, &event).unwrap();
        assert_eq!(cue["lethal"], true);
        assert_eq!(cue["actorGeneration"], sim.actor(42).unwrap().spawn_generation);
        assert!(cue.get("hp").is_none());
    }

    #[test]
    fn ordinary_combat_and_step_batches_omit_absent_optional_metadata() {
        let mut sim = Simulation::new(51235);
        sim.join(42, "Event test".into(), Faction::British).unwrap();
        let actor = sim.actor_mut(42).unwrap();
        actor.x = 13.5;
        actor.z = 0.0;
        actor.yaw = 0.0;
        actor.spawn_safe = 0.0;
        actor.cooldown = 0.0;
        sim.drain_events();
        let mut events = vec![];
        for tick in 1..=30 {
            assert!(sim.submit_input(42, InputFrame {
                seq: tick, tick: Some(tick),
                generation: Some(sim.actor(42).unwrap().spawn_generation),
                forward: 1.0, fire: tick == 1, reload: tick == 2,
                ..Default::default()
            }));
            sim.tick(sim::TICK_SECONDS);
            for event in sim.drain_events() { events.push(wire_sim_event(&sim, &event).unwrap()); }
        }
        for kind in ["shot", "reload", "step"] {
            assert!(events.iter().any(|event| event["type"] == kind), "real simulation produced {kind}");
        }
        let mut sequence = 0;
        let batches = crate::transport::event_batches("event-test", sim.round_number, sim.tick_number, sim.time, &mut sequence, events);
        for event in batches[0]["events"].as_array().unwrap() {
            assert_eq!(event["actorName"], "Event test");
            assert_eq!(event["actorFaction"], "british");
            assert!(event["actorGeneration"].is_u64());
            assert!(event.get("victimName").is_none());
            assert!(event.get("victimGeneration").is_none());
            for key in ["actorGeneration", "victimGeneration", "roundNumber", "tick", "seq"] {
                if let Some(value) = event.get(key) { assert!(value.is_u64(), "{key} must be an integer when present"); }
            }
        }
    }
}

#[cfg(test)]
mod latency_tests {
    use super::*;

    #[test]
    fn latency_only_accepts_a_matching_single_use_server_challenge() {
        let now = Instant::now();
        let mut latency = Latency::default();
        assert_eq!(latency.value(now), None);
        latency.reply(&[0; 16], now);
        assert_eq!(latency.value(now), None);
        let nonce = latency.challenge(now).unwrap();
        assert_eq!(nonce.len(), 16);
        assert!(latency.challenge(now + Duration::from_secs(3)).is_none());
        let mut wrong = nonce.clone();
        wrong[0] ^= 1;
        latency.reply(&wrong, now + Duration::from_millis(2));
        assert_eq!(latency.value(now), None);
        latency.reply(&nonce, now + Duration::from_millis(83));
        assert_eq!(latency.value(now + Duration::from_millis(83)), Some(83));
        latency.reply(&nonce, now + Duration::from_millis(500));
        assert_eq!(latency.value(now + Duration::from_millis(500)), Some(83));
        assert_ne!(
            latency.challenge(now + Duration::from_secs(3)).unwrap(),
            nonce
        );
    }

    #[test]
    fn latency_is_bounded_and_expired_samples_and_probes_cannot_appear_fresh() {
        let now = Instant::now();
        let mut latency = Latency::default();
        let nonce = latency.challenge(now).unwrap();
        latency.reply(&nonce, now + Duration::from_millis(2400));
        assert_eq!(latency.value(now + Duration::from_secs(3)), Some(999));
        assert_eq!(latency.value(now + Duration::from_millis(12400)), None);
        let old = latency.challenge(now + Duration::from_secs(13)).unwrap();
        let fresh = latency.challenge(now + Duration::from_secs(23)).unwrap();
        assert_ne!(old, fresh);
        latency.reply(&old, now + Duration::from_secs(23));
        assert_eq!(latency.value(now + Duration::from_secs(23)), None);
        latency.reply(&fresh, now + Duration::from_secs(33));
        assert_eq!(latency.value(now + Duration::from_secs(33)), None);
        assert!(latency.challenge(now + Duration::from_secs(33)).is_some());
    }
}

#[cfg(test)]
mod bot_round_tests {
    use super::*;

    #[test]
    fn round_restart_keeps_bot_memberships_and_creates_their_new_match_rows() {
        let temp = tempfile::tempdir().unwrap();
        let mut hub = Hub::new(Config {
            bind: "127.0.0.1:0".into(),
            database: temp.path().join("test.sqlite"),
            origins: vec![],
            identity_salt: "bot-round-test-salt".into(),
            empty_seconds: 300.0,
            reconnect_seconds: 30.0,
            max_rooms: 1,
            proxy: false,
        })
        .unwrap();
        let (player, _) = hub.db.session(None).unwrap().unwrap();
        let cid = db::id();
        let (tx, _rx) = crate::transport::channel();
        let (cancel, _cancelled) = watch::channel(None);
        hub.register(&player, cid.clone(), tx, cancel, "test", "test")
            .unwrap();
        hub.join(&player, &cid, None, "Observer", Faction::British, true)
            .unwrap();
        let room_id = hub.rooms.keys().next().unwrap().clone();
        let bot_ids: Vec<_> = hub.rooms[&room_id]
            .members
            .iter()
            .filter(|(_, member)| member.bot.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        let changes = hub.db.test_conn().total_changes();
        for _ in 0..30 {
            hub.tick().unwrap();
        }
        assert_eq!(
            hub.db.test_conn().total_changes(),
            changes,
            "movement/perception ticks never write to SQLite"
        );
        hub.rooms.get_mut(&room_id).unwrap().sim.time = sim::ROUND_SECONDS;
        hub.tick().unwrap();
        assert!(hub.rooms[&room_id].sim.ended);
        let previous_game = hub.rooms[&room_id].game.clone();
        hub.rooms.get_mut(&room_id).unwrap().ended_since =
            Some(Instant::now() - Duration::from_secs(9));
        hub.tick().unwrap();
        let room = &hub.rooms[&room_id];
        assert_eq!(room.sim.round_number, 2);
        assert!(!room.sim.ended);
        assert_ne!(room.game, previous_game);
        assert_eq!(room.sim.actors.len(), 3);
        for bot in bot_ids {
            assert!(room.members[&bot].bot.is_some());
            let rows: i64 = hub
                .db
                .test_conn()
                .query_row(
                    "SELECT count(*) FROM match_players WHERE player_id=?1",
                    &[&bot],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(rows, 2);
            let memberships: i64 = hub
                .db
                .test_conn()
                .query_row(
                    "SELECT count(*) FROM memberships WHERE player_id=?1",
                    &[&bot],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(memberships, 1);
        }
        hub.tick().unwrap();
        assert!(hub.rooms[&room_id].sim.actors.iter().all(|a| a.shots == 0));

        // Bot and human combat share the same event-to-UUID persistence path.
        // Resolve a normal close-range attack without changing HP or scores.
        let room = hub.rooms.get_mut(&room_id).unwrap();
        let human = room.members[&player].actor;
        room.sim.change_faction(human, Faction::British);
        let bot = room
            .members
            .values()
            .find(|m| m.bot.is_some())
            .unwrap()
            .actor;
        for (id, z) in [(bot, 0.0), (human, 1.2)] {
            let actor = room.sim.actor_mut(id).unwrap();
            actor.x = 0.0;
            actor.z = z;
            actor.y = 0.0;
            actor.yaw = 0.0;
            actor.pitch = 0.0;
            actor.spawn_safe = 0.0;
            actor.cooldown = 0.0;
        }
        let seq = room.sim.actor(bot).unwrap().ack + 1;
        assert!(room.sim.submit_input(
            bot,
            InputFrame {
                seq,
                melee: true,
                ..InputFrame::default()
            }
        ));
        room.sim.tick(sim::TICK_SECONDS);
        record_sim_events(&mut hub.db, room).unwrap();
        let roles: (i64, i64) = hub.db.test_conn().query_row(
            "SELECT k.is_bot,v.is_bot FROM combat_events c JOIN players k ON k.id=c.killer_id JOIN players v ON v.id=c.victim_id",
            &[], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(roles, (1, 0));
        assert_eq!(hub.db.test_conn().query_row("SELECT count(*) FROM events WHERE event_type IN ('player_kill','player_death')", &[], |r| r.get::<_, i64>(0)).unwrap(), 2);
    }
}

#[cfg(test)]
mod persistence_boundary_tests {
    use super::*;
    #[tokio::test]
    async fn kill_notifications_wait_for_commit_while_both_lobbies_keep_simulating() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let mut hub = Hub::new(Config {
            bind: "127.0.0.1:0".into(),
            database: path.clone(),
            origins: vec![],
            identity_salt: "storage-boundary-test-32-byte-salt".into(),
            empty_seconds: 300.0,
            reconnect_seconds: 30.0,
            max_rooms: 2,
            proxy: false,
        })
        .unwrap();
        let mut peers = vec![];
        for index in 0..2 {
            let (player, _) = hub.db.session(None).unwrap().unwrap();
            let cid = db::id();
            let (outbox, outgoing) = crate::transport::channel();
            let (cancel, cancelled) = watch::channel(None);
            hub.register(&player, cid.clone(), outbox, cancel, "test", "test")
                .unwrap();
            let lobby = hub.create_room().unwrap();
            hub.join(
                &player,
                &cid,
                Some(&lobby),
                &format!("Player {index}"),
                Faction::British,
                false,
            )
            .unwrap();
            peers.push((player, lobby, outgoing, cancelled));
        }
        hub.db.request(|_| Ok(())).await.unwrap();
        let lock = rusqlite::Connection::open(&path).unwrap();
        lock.execute_batch("BEGIN IMMEDIATE").unwrap();
        // Changing faction legitimately produces a self-death record/kill event.
        hub.loadout(&peers[0].0, Faction::German).unwrap();
        let room = hub.rooms.get_mut(&peers[0].1).unwrap();
        assert!(
            room.durable_pending
                .iter()
                .any(|(_, event)| event["type"] == "kill")
        );
        // A different actor firing while that kill waits for disk must still
        // deliver its presentation cue on this tick, with no state publish.
        let cue_player = room
            .members
            .iter()
            .find(|(_, member)| member.bot.is_some())
            .unwrap()
            .0
            .clone();
        let cue_actor = room.members[&cue_player].actor;
        room.members.get_mut(&cue_player).unwrap().bot = None;
        let actor = room.sim.actor_mut(cue_actor).unwrap();
        actor.cooldown = 0.0;
        actor.spawn_safe = 0.0;
        let generation = actor.spawn_generation;
        hub.input(
            &cue_player,
            InputFrame {
                seq: 1,
                tick: Some(1),
                generation: Some(generation),
                fire: true,
                ..Default::default()
            },
        );
        let starts = peers
            .iter()
            .map(|(_, id, _, _)| hub.rooms[id].sim.tick_number)
            .collect::<Vec<_>>();
        let before = Instant::now();
        for _ in 0..18 {
            hub.tick().unwrap();
        }
        assert!(before.elapsed() < Duration::from_millis(150));
        for ((_, id, _, _), start) in peers.iter().zip(starts) {
            assert_eq!(hub.rooms[id].sim.tick_number, start + 18);
        }
        let mut prompt_shots = 0;
        for (index, (_, _, outgoing, _)) in peers.iter_mut().enumerate() {
            while let Ok(raw) = outgoing.try_recv() {
                let packet: Value = serde_json::from_str(&raw).unwrap();
                if packet["type"] == "events" {
                    assert!(
                        !packet["events"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|event| event["type"] == "kill")
                    );
                }
                if index == 0 && packet["type"] == "cues" {
                    for event in packet["events"].as_array().unwrap() {
                        if event["type"] == "shot" && event["actor"] == cue_actor {
                            assert_eq!(event["tick"], 1);
                            assert_eq!(event["actorGeneration"], generation);
                            prompt_shots += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(
            prompt_shots, 1,
            "combat presentation must bypass the unrelated durable kill gate"
        );
        lock.execute_batch("ROLLBACK").unwrap();
        hub.db.request(|_| Ok(())).await.unwrap();
        for _ in 0..3 {
            hub.tick().unwrap();
        }
        let mut kills = 0;
        while let Ok(raw) = peers[0].2.try_recv() {
            let packet: Value = serde_json::from_str(&raw).unwrap();
            if packet["type"] == "events" {
                for event in packet["events"].as_array().unwrap() {
                    if event["type"] == "kill" {
                        kills += 1;
                        assert_eq!(event["roundNumber"], 1);
                        assert!(
                            event["tick"].as_u64().unwrap()
                                < hub.rooms[&peers[0].1].sim.tick_number
                        );
                    }
                }
            }
        }
        assert_eq!(kills, 1);
        hub.shutdown().unwrap();
        assert!(!hub.failed);
        assert!(hub.lobbies().is_err());
        hub.db.drain().await.unwrap();
    }
}
