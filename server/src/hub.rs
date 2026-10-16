use crate::{
    bots::{BotBrain, Navigation},
    db::{self, Db, EventRow},
    sim::{self, Faction, GameEvent, InputFrame, Simulation},
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
use tokio::sync::{mpsc, watch};

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
    pub tx: mpsc::Sender<String>,
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
    pending: Vec<GameEvent>,
    navigation: Navigation,
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
    fn snapshot(&self, events: &[GameEvent], connections: &HashMap<String, Endpoint>) -> Value {
        let now = Instant::now();
        let mut actors = serde_json::to_value(&self.sim.actors).expect("serializable actors");
        for actor in actors.as_array_mut().expect("actor array") {
            actor["bot"] = json!(
                self.members
                    .values()
                    .any(|m| m.bot.is_some() && Some(u64::from(m.actor)) == actor["id"].as_u64())
            );
            let latency = self
                .members
                .iter()
                .find(|(_, member)| Some(u64::from(member.actor)) == actor["id"].as_u64())
                .and_then(|(player, _)| connections.get(player))
                .and_then(|endpoint| endpoint.latency.value(now));
            actor["ping"] = json!(latency);
        }
        json!({"type":"snapshot","inputTiming":"tick-v1","tick":self.sim.tick_number,"time":self.sim.time,"remaining":self.sim.remaining,"roundNumber":self.sim.round_number,"ended":self.sim.ended,"winner":self.sim.winner,"actors":actors,"events":events})
    }
}
pub struct Hub {
    pub config: Config,
    pub db: Db,
    rooms: HashMap<String, Room>,
    pub connections: HashMap<String, Endpoint>,
    pub failed: bool,
    rate: HashMap<String, VecDeque<Instant>>,
    name_index: usize,
    pub internal_token: Option<String>,
    pub managed_lobby: Option<String>,
}
pub type HResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
impl Hub {
    pub fn new(config: Config) -> HResult<Self> {
        let db = Db::open(&config.database)?;
        Ok(Self {
            config,
            db,
            rooms: HashMap::new(),
            connections: HashMap::new(),
            failed: false,
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
            && e.tx.try_send(message.to_string()).is_err()
        {
            let _ = e.cancel.send(Some("slow_consumer".into()));
        }
    }
    fn broadcast(&self, room: &Room, message: Value) {
        let encoded = message.to_string();
        for player in room.members.keys() {
            if let Some(e) = self.connections.get(player)
                && e.tx.try_send(encoded.clone()).is_err()
            {
                let _ = e.cancel.send(Some("slow_consumer".into()));
            }
        }
    }
    pub fn register(
        &mut self,
        player: &str,
        cid: String,
        tx: mpsc::Sender<String>,
        cancel: watch::Sender<Option<String>>,
        ip: &str,
        ua: &str,
    ) -> HResult<()> {
        if let Some(old) = self.connections.remove(player) {
            let _ = old
                .tx
                .try_send(error("session_replaced", "Connected in another tab.").to_string());
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
                navigation,
            },
        );
        Ok(id)
    }
    /// A managed process owns exactly one GameLift session, including its rounds.
    pub fn activate_managed(&mut self, id: &str, name: &str) -> HResult<()> {
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
            let packet = json!({"type":"joined","lobbyId":room.id,"lobbyName":room.name,"actorId":actor,"snapshot":room.snapshot(&[], &self.connections)});
            self.send(player, packet);
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
        let stats_before_join = self.db.conn.query_row(
            "SELECT kills,deaths,shots,hits FROM match_players WHERE match_id=?1 AND player_id=?2",
            params![room.game, player],
            |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?]),
        )?;
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
        let packet = json!({"type":"joined","lobbyId":room.id,"lobbyName":room.name,"actorId":actor,"snapshot":room.snapshot(&[], &self.connections)});
        self.send(player, packet);
        Ok(())
    }
    pub fn leave(&mut self, player: &str, reason: &str, notify: bool) -> HResult<()> {
        for room in self.rooms.values_mut() {
            if let Some(member) = room.members.get(player) {
                sync_stats(&self.db, room)?;
                self.db
                    .leave(&member.membership, &room.id, &room.game, player, reason)?;
                let actor = member.actor;
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
        let (eid, at) = self
            .db
            .chat(&room.id, &room.game, player, cid, &name, text)?;
        let msg = json!({"type":"chat","id":eid,"actorId":actor,"name":name,"text":text,"at":at});
        let rid = room.id.clone();
        self.broadcast(&self.rooms[&rid], msg);
        Ok(())
    }
    pub fn profile(&mut self, player: &str, name: &str) -> HResult<()> {
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
        let mut closed = vec![];
        for room in self.rooms.values_mut() {
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
            if room.sim.ended && room.ended_since.is_none() {
                room.ended_since = Some(Instant::now());
                let winner = room
                    .members
                    .iter()
                    .find(|(_, m)| Some(m.actor) == room.sim.winner)
                    .map(|(p, _)| p.as_str());
                sync_stats(&self.db, room)?;
                self.db.conn.execute("UPDATE matches SET ended_at=?1,end_reason='time_limit',winner_player_id=?2 WHERE id=?3",params![db::now_ms(),winner,room.game])?;
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
                room.sim.restart_round();
                room.ended_since = None;
                room.game = db::id();
                self.db
                    .create_match(&room.game, &room.id, room.sim.round_number)?;
                sync_stats(&self.db, room)?;
            }
            if room.sim.tick_number % 3 == 0 {
                packets.push((
                    room.id.clone(),
                    room.snapshot(&room.pending, &self.connections),
                ));
                room.pending.clear();
            }
        }
        for (id, packet) in packets {
            self.broadcast(&self.rooms[&id], packet);
        }
        for id in closed {
            self.close_room(&id, "inactive")?;
        }
        Ok(())
    }
    fn close_room(&mut self, id: &str, reason: &str) -> HResult<()> {
        if let Some(room) = self.rooms.remove(id) {
            let at = db::now_ms();
            self.db.conn.execute(
                "UPDATE lobbies SET closed_at=?1,close_reason=?2 WHERE id=?3",
                params![at, reason, id],
            )?;
            self.db.conn.execute(
                "UPDATE matches SET ended_at=?1,end_reason=?2 WHERE id=?3 AND ended_at IS NULL",
                params![at, reason, room.game],
            )?;
        }
        Ok(())
    }
    pub fn fail(&mut self) {
        self.failed = true;
        for e in self.connections.values() {
            let _ =
                e.tx.try_send(error("server_busy", "Server unavailable.").to_string());
            let _ = e.cancel.send(Some("server_busy".into()));
        }
    }
    pub fn shutdown(&mut self) -> HResult<()> {
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
        self.db
            .conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        Ok(())
    }
}
/// Two AI accompany one or two connected humans. Spectators are humans for
/// this threshold; reconnect reservations are not. Bots never consume a seat
/// ahead of a human, and zero connected humans removes every bot immediately.
fn reconcile_bots(
    db: &mut Db,
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
        let stats_before_join = db.conn.query_row(
            "SELECT kills,deaths,shots,hits FROM match_players WHERE match_id=?1 AND player_id=?2",
            params![room.game, player],
            |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?]),
        )?;
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

fn remove_one_bot(db: &mut Db, room: &mut Room, reason: &str) -> HResult<()> {
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
    room.sim.leave(member.actor);
    room.members.remove(&player);
    Ok(())
}

fn sync_stats(db: &Db, room: &Room) -> rusqlite::Result<()> {
    for (player, m) in &room.members {
        if let Some(a) = room.sim.actor(m.actor) {
            let faction = serde_json::to_value(a.faction).unwrap();
            let before = if m.stats_game == room.game {
                m.stats_before_join
            } else {
                [0; 4]
            };
            db.conn.execute("INSERT INTO match_players(match_id,player_id,name,faction,joined_at,kills,deaths,shots,hits) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(match_id,player_id) DO UPDATE SET name=excluded.name,faction=excluded.faction,kills=excluded.kills,deaths=excluded.deaths,shots=excluded.shots,hits=excluded.hits",params![room.game,player,a.name,faction.as_str(),db::now_ms(),before[0]+i64::from(a.kills),before[1]+i64::from(a.deaths),before[2]+i64::from(a.shots),before[3]+i64::from(a.hits)])?;
        }
    }
    Ok(())
}
pub fn error(code: &str, message: &str) -> Value {
    json!({"type":"error","code":code,"message":message})
}
pub fn sanitize_name(name: &str) -> String {
    sim::sanitize_name(name)
}

fn record_sim_events(db: &mut Db, room: &mut Room) -> rusqlite::Result<()> {
    for event in room.sim.drain_events() {
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
                db.kill(
                    &room.id,
                    &room.game,
                    k,
                    v,
                    event.weapon.as_deref().unwrap_or("rifle"),
                    event.headshot.unwrap_or(false),
                    json!({"serverTime":room.sim.time,"event":event}),
                )?;
                sync_stats(db, room)?;
            }
        }
        room.pending.push(event);
    }
    Ok(())
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
        let (tx, _rx) = mpsc::channel(256);
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
        let changes = hub.db.conn.total_changes();
        for _ in 0..30 {
            hub.tick().unwrap();
        }
        assert_eq!(
            hub.db.conn.total_changes(),
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
                .conn
                .query_row(
                    "SELECT count(*) FROM match_players WHERE player_id=?1",
                    [&bot],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(rows, 2);
            let memberships: i64 = hub
                .db
                .conn
                .query_row(
                    "SELECT count(*) FROM memberships WHERE player_id=?1",
                    [&bot],
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
        let roles: (i64, i64) = hub.db.conn.query_row(
            "SELECT k.is_bot,v.is_bot FROM combat_events c JOIN players k ON k.id=c.killer_id JOIN players v ON v.id=c.victim_id",
            [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(roles, (1, 0));
        assert_eq!(hub.db.conn.query_row("SELECT count(*) FROM events WHERE event_type IN ('player_kill','player_death')", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    }
}
