use crate::sim::DEFAULT_PLAYER_NAME;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[path = "visitors.rs"]
pub(crate) mod visitors;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub struct Db {
    pub conn: Connection,
}
pub struct EventRow<'a> {
    pub kind: &'a str,
    pub lobby: Option<&'a str>,
    pub game: Option<&'a str>,
    pub connection: Option<&'a str>,
    pub actor: Option<&'a str>,
    pub target: Option<&'a str>,
    pub data: Value,
}
#[derive(Debug, Serialize)]
pub struct LeaderboardRow {
    pub name: String,
    pub kills: i64,
    pub deaths: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leaderboard {
    pub all_time: Vec<LeaderboardRow>,
    pub last24_hours: Vec<LeaderboardRow>,
}

/// Formatting and case are not separate leaderboard identities. Authentication
/// always remains attached to a UUID, never to this public, non-unique name.
fn canonical_name(name: &str) -> Option<(String, String)> {
    let mut chars = name.chars().peekable();
    let mut plain = String::new();
    while let Some(c) = chars.next() {
        if c == '^' && chars.peek().is_some_and(char::is_ascii_digit) {
            chars.next();
        } else if !c.is_control() || c.is_whitespace() {
            plain.push(c);
        }
    }
    let display = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    let key = display.to_lowercase();
    if key.is_empty() || key == "unknown soldier" {
        None
    } else {
        Some((key, display))
    }
}
pub(crate) fn register_name(conn: &Connection, name: &str, at: i64) -> rusqlite::Result<Option<String>> {
    let Some((key, display)) = canonical_name(name) else {
        return Ok(None);
    };
    conn.execute("INSERT INTO leaderboard_names(name_key,display_name,first_seen,last_seen) VALUES(?1,?2,?3,?3) ON CONFLICT(name_key) DO UPDATE SET last_seen=max(last_seen,excluded.last_seen)", params![key,display,at])?;
    Ok(Some(key))
}
pub(crate) fn record_score(
    conn: &Connection,
    combat: &str,
    player: &str,
    role: &str,
    name: &str,
    at: i64,
) -> rusqlite::Result<()> {
    let Some(key) = register_name(conn, name, at)? else {
        return Ok(());
    };
    let added = conn.execute("INSERT OR IGNORE INTO leaderboard_events(combat_id,role,player_id,name_key,created_at) VALUES(?1,?2,?3,?4,?5)",params![combat,role,player,key,at])?;
    if added > 0 {
        conn.execute(
            "UPDATE leaderboard_names SET kills=kills+?1,deaths=deaths+?2 WHERE name_key=?3",
            params![i64::from(role == "kill"), i64::from(role == "death"), key],
        )?;
    }
    Ok(())
}
impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(3))?;
        conn.execute_batch(include_str!("../schema.sql"))?;
        let mut db = Self { conn };
        db.migrate_community()?;
        db.recover()?;
        Ok(db)
    }
    fn migrate_community(&mut self) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=2)",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            return tx.commit();
        }
        let columns: Vec<String> = {
            let mut statement = tx.prepare("PRAGMA table_info(players)")?;
            statement
                .query_map([], |r| r.get(1))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (name, definition) in [
            ("name_key", "TEXT"),
            ("is_bot", "INTEGER NOT NULL DEFAULT 0 CHECK(is_bot IN(0,1))"),
            ("bot_key", "TEXT"),
        ] {
            if !columns.iter().any(|c| c == name) {
                tx.execute_batch(&format!(
                    "ALTER TABLE players ADD COLUMN {name} {definition}"
                ))?;
            }
        }
        tx.execute_batch("CREATE INDEX IF NOT EXISTS players_name_key ON players(name_key) WHERE is_bot=0; CREATE UNIQUE INDEX IF NOT EXISTS players_bot_key ON players(bot_key) WHERE bot_key IS NOT NULL;")?;
        let players: Vec<(String, String, i64)> = {
            let mut s =
                tx.prepare("SELECT id,display_name,created_at FROM players WHERE is_bot=0")?;
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (player, name, at) in players {
            let key = register_name(&tx, &name, at)?;
            tx.execute(
                "UPDATE players SET name_key=?1 WHERE id=?2",
                params![key, player],
            )?;
        }
        // Recover names as they were at each recorded kill, using ordered
        // profile/join events. Older databases without that history fall back to
        // the round name, then the preserved current name.
        type HistoricalCombat = (String, String, String, i64, String, String, bool, bool);
        let combat: Vec<HistoricalCombat> = {
            let mut s=tx.prepare("SELECT c.id,c.killer_id,c.victim_id,c.created_at,
              COALESCE((SELECT json_extract(e.data,'$.name') FROM events e WHERE e.actor_player_id=c.killer_id AND e.event_type IN('player_enter','profile_change') AND e.seq<=k.seq AND json_type(e.data,'$.name')='text' ORDER BY e.seq DESC LIMIT 1),(SELECT name FROM match_players WHERE match_id=c.match_id AND player_id=c.killer_id),kp.display_name),
              COALESCE((SELECT json_extract(e.data,'$.name') FROM events e WHERE e.actor_player_id=c.victim_id AND e.event_type IN('player_enter','profile_change') AND e.seq<=k.seq AND json_type(e.data,'$.name')='text' ORDER BY e.seq DESC LIMIT 1),(SELECT name FROM match_players WHERE match_id=c.match_id AND player_id=c.victim_id),vp.display_name),kp.is_bot,vp.is_bot
              FROM combat_events c JOIN events k ON k.id=c.kill_event_id JOIN players kp ON kp.id=c.killer_id JOIN players vp ON vp.id=c.victim_id ORDER BY k.seq")?;
            s.query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?
        };
        for (combat, killer, victim, at, kname, vname, kbot, vbot) in combat {
            if !kbot && killer != victim {
                record_score(&tx, &combat, &killer, "kill", &kname, at)?;
            }
            if !vbot {
                record_score(&tx, &combat, &victim, "death", &vname, at)?;
            }
        }
        tx.execute(
            "INSERT INTO schema_migrations(version,applied_at) VALUES(2,?1)",
            [now_ms()],
        )?;
        tx.commit()
    }
    pub fn set_name(&self, player: &str, name: &str) -> rusqlite::Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let bot: bool = tx.query_row("SELECT is_bot FROM players WHERE id=?1", [player], |r| {
            r.get(0)
        })?;
        let key = if bot {
            None
        } else {
            register_name(&tx, name, now_ms())?
        };
        tx.execute(
            "UPDATE players SET display_name=?1,name_key=?2,last_seen=?3 WHERE id=?4",
            params![name, key, now_ms(), player],
        )?;
        tx.commit()
    }
    /// The stable server-only key creates no usable browser credential.
    pub fn ensure_bot(&self, key: &str, name: &str) -> rusqlite::Result<String> {
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM players WHERE bot_key=?1 AND is_bot=1",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(player) = existing {
            self.set_name(&player, name)?;
            return Ok(player);
        }
        let player = id();
        self.conn.execute("INSERT INTO players(id,credential_hash,display_name,created_at,last_seen,is_bot,bot_key) VALUES(?1,?2,?3,?4,?4,1,?5)",params![player,format!("bot:{}",id()),name,now_ms(),key])?;
        Ok(player)
    }
    pub fn leaderboard(&self, at: i64) -> rusqlite::Result<Leaderboard> {
        let mut all=self.conn.prepare("SELECT display_name,kills,deaths FROM leaderboard_names ORDER BY kills DESC,deaths,name_key")?;
        let row = |r: &rusqlite::Row<'_>| {
            Ok(LeaderboardRow {
                name: r.get(0)?,
                kills: r.get(1)?,
                deaths: r.get(2)?,
            })
        };
        let all_time = all.query_map([], row)?.collect::<rusqlite::Result<_>>()?;
        let mut recent=self.conn.prepare("WITH scores AS (SELECT name_key,sum(role='kill') kills,sum(role='death') deaths FROM leaderboard_events WHERE created_at>=?1 AND created_at<=?2 GROUP BY name_key) SELECT n.display_name,coalesce(s.kills,0) kills,coalesce(s.deaths,0) deaths FROM leaderboard_names n LEFT JOIN scores s USING(name_key) ORDER BY kills DESC,deaths,n.name_key")?;
        let last24_hours = recent
            .query_map(params![at - 86_400_000, at], row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Leaderboard {
            all_time,
            last24_hours,
        })
    }
    pub fn feedback(
        &mut self,
        message: &str,
        email: Option<&str>,
        ip_hash: &str,
    ) -> rusqlite::Result<Option<String>> {
        let tx = self.conn.transaction()?;
        let at = now_ms();
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM feedback_requests WHERE ip_hash=?1 AND created_at>=?2",
            params![ip_hash, at - 3_600_000],
            |r| r.get(0),
        )?;
        if count >= 5 {
            return Ok(None);
        }
        let request = id();
        tx.execute("INSERT INTO feedback_requests(id,message,email,ip_hash,created_at) VALUES(?1,?2,?3,?4,?5)",params![request,message,email,ip_hash,at])?;
        tx.execute(
            "INSERT INTO feedback_events(id,request_id,event_type,at) VALUES(?1,?2,'submitted',?3)",
            params![id(), request, at],
        )?;
        tx.commit()?;
        Ok(Some(request))
    }
    fn recover(&mut self) -> rusqlite::Result<()> {
        let at = now_ms();
        let tx = self.conn.transaction()?;
        let interrupted: Vec<(String, String, String)> = {
            let mut statement =
                tx.prepare("SELECT id,lobby_id,player_id FROM memberships WHERE left_at IS NULL")?;
            statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (membership, lobby, player) in interrupted {
            tx.execute("INSERT INTO events(id,event_type,at,lobby_id,actor_player_id,data) VALUES(?1,'player_leave',?2,?3,?4,?5)",params![id(),at,lobby,player,json!({"reason":"server_restart","membershipId":membership}).to_string()])?;
        }
        tx.execute("UPDATE memberships SET left_at=?1, leave_reason='server_restart' WHERE left_at IS NULL", [at])?;
        tx.execute("UPDATE connections SET closed_at=?1, end_reason='server_restart' WHERE closed_at IS NULL", [at])?;
        tx.execute(
            "UPDATE matches SET ended_at=?1, end_reason='server_restart' WHERE ended_at IS NULL",
            [at],
        )?;
        tx.execute("UPDATE lobbies SET closed_at=?1, close_reason='server_restart' WHERE closed_at IS NULL", [at])?;
        tx.commit()?;
        self.event(EventRow {
            kind: "server_start",
            lobby: None,
            game: None,
            connection: None,
            actor: None,
            target: None,
            data: json!({"version":1}),
        })?;
        Ok(())
    }
    pub fn session(&mut self, token: Option<&str>) -> rusqlite::Result<Option<(String, String)>> {
        if let Some(token) = token {
            if token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Ok(None);
            }
            let player: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM players WHERE credential_hash=?1 AND is_bot=0",
                    [hash(token)],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(player) = player {
                self.conn.execute(
                    "UPDATE players SET last_seen=?1 WHERE id=?2",
                    params![now_ms(), player],
                )?;
                return Ok(Some((player, token.to_owned())));
            }
            return Ok(None);
        }
        let player = id();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let at = now_ms();
        self.conn.execute(
            "INSERT INTO players(id,credential_hash,display_name,created_at,last_seen) VALUES(?1,?2,?3,?4,?4)",
            params![player, hash(&token), DEFAULT_PLAYER_NAME, at],
        )?;
        Ok(Some((player, token)))
    }
    pub fn authenticate(&self, token: &str) -> rusqlite::Result<Option<String>> {
        if token.len() != 64 {
            return Ok(None);
        }
        self.conn
            .query_row(
                "SELECT id FROM players WHERE credential_hash=?1 AND is_bot=0",
                [hash(token)],
                |r| r.get(0),
            )
            .optional()
    }
    pub fn event(&self, e: EventRow<'_>) -> rusqlite::Result<String> {
        let eid = id();
        self.conn.execute("INSERT INTO events(id,event_type,at,lobby_id,match_id,connection_id,actor_player_id,target_player_id,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![eid,e.kind,now_ms(),e.lobby,e.game,e.connection,e.actor,e.target,e.data.to_string()])?;
        Ok(eid)
    }
    pub fn connect(
        &self,
        cid: &str,
        player: &str,
        ip_hash: &str,
        ua_hash: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute("INSERT INTO connections(id,player_id,opened_at,ip_hash,ua_hash) VALUES(?1,?2,?3,?4,?5)",params![cid,player,now_ms(),ip_hash,ua_hash])?;
        self.conn.execute(
            "UPDATE players SET last_seen=?1 WHERE id=?2",
            params![now_ms(), player],
        )?;
        Ok(())
    }
    pub fn disconnect(&self, cid: &str, reason: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE connections SET closed_at=?1,end_reason=?2 WHERE id=?3 AND closed_at IS NULL",
            params![now_ms(), reason, cid],
        )?;
        Ok(())
    }
    pub fn create_lobby(&self, lobby: &str, name: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO lobbies(id,name,created_at) VALUES(?1,?2,?3)",
            params![lobby, name, now_ms()],
        )?;
        Ok(())
    }
    pub fn create_match(&self, game: &str, lobby: &str, round: u64) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO matches(id,lobby_id,round_number,started_at) VALUES(?1,?2,?3,?4)",
            params![game, lobby, round as i64, now_ms()],
        )?;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)] // One transactional membership row and its event.
    pub fn join(
        &mut self,
        membership: &str,
        lobby: &str,
        game: &str,
        player: &str,
        actor: u32,
        name: &str,
        faction: &str,
        cid: &str,
        spectator: bool,
    ) -> rusqlite::Result<()> {
        self.join_with_connection(
            membership,
            lobby,
            game,
            player,
            actor,
            name,
            faction,
            Some(cid),
            spectator,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn join_bot(
        &mut self,
        membership: &str,
        lobby: &str,
        game: &str,
        player: &str,
        actor: u32,
        name: &str,
        faction: &str,
    ) -> rusqlite::Result<()> {
        self.join_with_connection(
            membership, lobby, game, player, actor, name, faction, None, false,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn join_with_connection(
        &mut self,
        membership: &str,
        lobby: &str,
        game: &str,
        player: &str,
        actor: u32,
        name: &str,
        faction: &str,
        cid: Option<&str>,
        spectator: bool,
    ) -> rusqlite::Result<()> {
        let at = now_ms();
        let tx = self.conn.transaction()?;
        let bot: bool = tx.query_row("SELECT is_bot FROM players WHERE id=?1", [player], |r| {
            r.get(0)
        })?;
        let key = if bot {
            None
        } else {
            register_name(&tx, name, at)?
        };
        tx.execute("INSERT INTO memberships(id,lobby_id,player_id,actor_id,name_at_join,faction,joined_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![membership,lobby,player,actor,name,faction,at])?;
        tx.execute("INSERT INTO match_players(match_id,player_id,name,faction,joined_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(match_id,player_id) DO UPDATE SET name=excluded.name,faction=excluded.faction",params![game,player,name,faction,at])?;
        tx.execute(
            "UPDATE players SET display_name=?1,last_seen=?2,name_key=?4 WHERE id=?3",
            params![name, at, player, key],
        )?;
        tx.execute("INSERT INTO events(id,event_type,at,lobby_id,match_id,connection_id,actor_player_id,data) VALUES(?1,'player_enter',?2,?3,?4,?5,?6,?7)",params![id(),at,lobby,game,cid,player,json!({"membershipId":membership,"actorId":actor,"name":name,"faction":faction,"spectator":spectator}).to_string()])?;
        tx.commit()
    }
    pub fn leave(
        &mut self,
        membership: &str,
        lobby: &str,
        game: &str,
        player: &str,
        reason: &str,
    ) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        let at = now_ms();
        let changed = tx.execute(
            "UPDATE memberships SET left_at=?1,leave_reason=?2 WHERE id=?3 AND left_at IS NULL",
            params![at, reason, membership],
        )?;
        if changed > 0 {
            tx.execute("INSERT INTO events(id,event_type,at,lobby_id,match_id,actor_player_id,data) VALUES(?1,'player_leave',?2,?3,?4,?5,?6)",params![id(),at,lobby,game,player,json!({"membershipId":membership,"reason":reason}).to_string()])?;
        }
        tx.commit()
    }
    pub fn chat(
        &mut self,
        lobby: &str,
        game: &str,
        player: &str,
        cid: &str,
        name: &str,
        text: &str,
    ) -> rusqlite::Result<(String, i64)> {
        let tx = self.conn.transaction()?;
        let eid = id();
        let at = now_ms();
        tx.execute("INSERT INTO events(id,event_type,at,lobby_id,match_id,connection_id,actor_player_id,data) VALUES(?1,'chat',?2,?3,?4,?5,?6,'{}')",params![eid,at,lobby,game,cid,player])?;
        tx.execute("INSERT INTO chat_messages(id,lobby_id,match_id,player_id,name,body,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![eid,lobby,game,player,name,text,at])?;
        tx.commit()?;
        Ok((eid, at))
    }
    #[allow(clippy::too_many_arguments)] // One atomic combat record links both event roles.
    pub fn kill(
        &mut self,
        lobby: &str,
        game: &str,
        killer: &str,
        victim: &str,
        weapon: &str,
        headshot: bool,
        data: Value,
    ) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        let kid = id();
        let did = id();
        let combat = id();
        let at = now_ms();
        let mut detail = data;
        detail["combatId"] = json!(combat);
        for (eid, kind, actor, target) in [
            (&kid, "player_kill", killer, victim),
            (&did, "player_death", victim, killer),
        ] {
            tx.execute("INSERT INTO events(id,event_type,at,lobby_id,match_id,actor_player_id,target_player_id,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![eid,kind,at,lobby,game,actor,target,detail.to_string()])?;
        }
        tx.execute("INSERT INTO combat_events(id,kill_event_id,death_event_id,match_id,killer_id,victim_id,weapon,headshot,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![combat,kid,did,game,killer,victim,weapon,headshot,at])?;
        for (player, role) in [(killer, "kill"), (victim, "death")] {
            let (name, bot): (String, bool) = tx.query_row(
                "SELECT display_name,is_bot FROM players WHERE id=?1",
                [player],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            // A faction-change/self-death is a death, never a credited kill.
            if !bot && (role != "kill" || killer != victim) {
                record_score(&tx, &combat, player, role, &name, at)?;
            }
        }
        tx.commit()
    }
}

#[cfg(test)]
#[path = "community_db_tests.rs"]
mod community_tests;

#[cfg(test)]
#[path = "visitor_db_tests.rs"]
mod visitor_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_require_secret_and_survive_restart() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("events.sqlite");
        let mut db = Db::open(&path).unwrap();
        let (p, t) = db.session(None).unwrap().unwrap();
        let stored_name = |db: &Db, player: &str| {
            db.conn
                .query_row(
                    "SELECT display_name FROM players WHERE id=?1",
                    [player],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        };
        assert_eq!(stored_name(&db, &p), "Unknown Soldier");
        db.conn
            .execute(
                "UPDATE players SET display_name=?1 WHERE id=?2",
                params!["^7Chri^9s", p],
            )
            .unwrap();
        assert_eq!(db.authenticate(&t).unwrap(), Some(p.clone()));
        assert_eq!(db.authenticate(&"0".repeat(64)).unwrap(), None);
        drop(db);
        let mut db = Db::open(&path).unwrap();
        assert_eq!(db.session(Some(&t)).unwrap().unwrap().0, p);
        assert_eq!(
            stored_name(&db, &p),
            "^7Chri^9s",
            "resuming an existing identity preserves its custom name"
        );
        assert_ne!(db.session(None).unwrap().unwrap().0, p);
    }
    #[test]
    fn new_identity_uses_default_name_with_an_existing_legacy_schema() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("legacy.sqlite");
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch("CREATE TABLE players(id TEXT PRIMARY KEY,credential_hash TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL DEFAULT 'Player',created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL);INSERT INTO players VALUES('existing','existing-hash','Player',0,0);").unwrap();
        drop(legacy);
        let mut db = Db::open(&path).unwrap();
        let (player, _) = db.session(None).unwrap().unwrap();
        let name: String = db
            .conn
            .query_row(
                "SELECT display_name FROM players WHERE id=?1",
                [&player],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Unknown Soldier");
        let previous: String = db
            .conn
            .query_row(
                "SELECT display_name FROM players WHERE id='existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            previous, "Player",
            "the default change must not rename existing identities"
        );
    }
    #[test]
    fn linked_kill_death_chat_and_recovery_are_durable() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("events.sqlite");
        let mut db = Db::open(&path).unwrap();
        let (p, _) = db.session(None).unwrap().unwrap();
        let (q, _) = db.session(None).unwrap().unwrap();
        db.create_lobby("l", "Rommel Alpha").unwrap();
        db.create_match("m", "l", 1).unwrap();
        db.connect("c", &p, "iphash", "uahash").unwrap();
        db.join(
            "membership",
            "l",
            "m",
            &p,
            1,
            "Player",
            "british",
            "c",
            false,
        )
        .unwrap();
        db.chat("l", "m", &p, "c", "Player", "<script>hello</script>")
            .unwrap();
        db.kill("l", "m", &p, &q, "rifle", true, json!({"time":42}))
            .unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM combat_events", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM events WHERE event_type IN('player_kill','player_death')",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM events WHERE event_type='player_leave'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            db.conn
                .query_row("SELECT body FROM chat_messages", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "<script>hello</script>"
        );
        assert_eq!(
            db.conn
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
}
