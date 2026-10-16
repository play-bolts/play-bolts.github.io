//! Authenticated loopback bridge for the GameLift supervisor. Gameplay remains
//! local; durable records replicate asynchronously to the existing SQLite store.
use crate::{
    app::Shared,
    db::{self, Db},
    hub::HResult,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rusqlite::{
    params, params_from_iter,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Value, json};

const TABLES: &[&str] = &[
    "connections",
    "lobbies",
    "matches",
    "memberships",
    "match_players",
    "events",
    "chat_messages",
    "combat_events",
];

pub async fn handle(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let mut hub = state.lock().await;
    let supplied = headers
        .get("x-bolts-internal")
        .and_then(|v| v.to_str().ok());
    if hub.internal_token.as_deref().is_none() || supplied != hub.internal_token.as_deref() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let storage = hub.db.clone();
    let managed = hub.managed_lobby.clone();
    let result: HResult<Value> = async {
        match body["op"].as_str() {
            Some("activate") => {
                hub.activate_managed(string(&body, "session")?, string(&body, "name")?)?;
                drop(hub);
                storage.request(|_| Ok(())).await?;
                Ok(json!({"ok":true}))
            }
            Some("status") => Ok(hub.managed_status()),
            Some("shutdown") => {
                hub.shutdown()?;
                drop(hub);
                storage.request(|_| Ok(())).await?;
                storage.check()?;
                Ok(json!({"ok":true}))
            }
            Some("authenticate") => {
                if managed.is_some() { return Err("not a directory".into()); }
                let token = string(&body, "token")?.to_owned();
                drop(hub);
                let player = storage.request(move |db| Ok(db.authenticate(&token)?)).await?;
                Ok(json!({"playerId":player}))
            }
            Some("identity") => {
                let player = string(&body, "playerId")?.to_owned();
                let token = string(&body, "token")?.to_owned();
                uuid::Uuid::parse_str(&player)?;
                if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("invalid token".into()); }
                if managed.is_none() { return Err("game not active".into()); }
                drop(hub);
                storage.request(move |db| {
                    db.conn.execute("INSERT INTO players(id,credential_hash,created_at,last_seen) VALUES(?1,?2,?3,?3) ON CONFLICT(id) DO UPDATE SET credential_hash=excluded.credential_hash,last_seen=excluded.last_seen",params![player,db::hash(&token),db::now_ms()])?;
                    Ok(())
                }).await?;
                Ok(json!({"ok":true}))
            }
            Some("export") => {
                let session = managed.ok_or("not a managed game")?;
                let after = body["after"].as_i64().unwrap_or(0);
                drop(hub);
                storage.request(move |db| export(db, &session, after)).await
            }
            Some("import") => {
                if managed.is_some() { return Err("not a directory".into()); }
                drop(hub);
                let bytes = body.to_string().len();
                storage.request_sized(bytes, move |db| import(db, &body["batch"])).await?;
                Ok(json!({"ok":true}))
            }
            _ => Err("invalid operation".into()),
        }
    }.await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            tracing::warn!(%error,"cluster request failed");
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_cluster_request"})),
            )
                .into_response()
        }
    }
}
fn string<'a>(body: &'a Value, key: &str) -> HResult<&'a str> {
    body[key].as_str().ok_or_else(|| "missing field".into())
}
fn rows(db: &Db, sql: &str, values: &[&dyn rusqlite::ToSql]) -> HResult<Value> {
    let mut statement = db.conn.prepare(sql)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let mut query = statement.query(values)?;
    let mut result = vec![];
    while let Some(row) = query.next()? {
        let mut value = serde_json::Map::new();
        for (i, column) in columns.iter().enumerate() {
            let v = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(v) => json!(std::str::from_utf8(v)?),
                ValueRef::Blob(_) => return Err("unexpected binary record".into()),
            };
            value.insert(column.clone(), v);
        }
        result.push(Value::Object(value));
    }
    Ok(Value::Array(result))
}
fn export(db: &Db, session: &str, after: i64) -> HResult<Value> {
    let mut tables = serde_json::Map::new();
    // Kill and death rows are produced atomically. Export through the current
    // high-water mark so both foreign keys always precede their combat record.
    let through: i64 = db
        .conn
        .query_row("SELECT coalesce(max(seq),0) FROM events", [], |r| r.get(0))?;
    tables.insert(
        "players".into(),
        rows(
            db,
            "SELECT id,display_name,created_at,last_seen,is_bot,bot_key FROM players",
            &[],
        )?,
    );
    for table in TABLES {
        let condition = match *table {
            "events" => " WHERE seq>?1 AND seq<=?2",
            "chat_messages" => " WHERE id IN (SELECT id FROM events WHERE seq>?1 AND seq<=?2)",
            "combat_events" => {
                " WHERE kill_event_id IN (SELECT id FROM events WHERE seq>?1 AND seq<=?2) OR death_event_id IN (SELECT id FROM events WHERE seq>?1 AND seq<=?2)"
            }
            _ => "",
        };
        let values: Vec<&dyn rusqlite::ToSql> = if condition.is_empty() {
            vec![]
        } else {
            vec![&after, &through]
        };
        tables.insert(
            table.to_string(),
            rows(db, &format!("SELECT * FROM {table}{condition}"), &values)?,
        );
    }
    tables.insert(
        "names".into(),
        rows(
            db,
            "SELECT name_key,display_name,first_seen FROM leaderboard_names",
            &[],
        )?,
    );
    tables.insert("scores".into(),rows(db,"SELECT s.* FROM leaderboard_events s JOIN combat_events c ON c.id=s.combat_id JOIN events e ON e.id=c.kill_event_id WHERE e.seq>?1 AND e.seq<=?2",&[&after,&through])?);
    Ok(json!({"session":session,"after":after,"through":through,"tables":tables}))
}
fn records<'a>(tables: &'a Value, key: &str) -> HResult<&'a Vec<Value>> {
    tables[key]
        .as_array()
        .ok_or_else(|| "missing records".into())
}
fn import(db: &mut Db, batch: &Value) -> HResult<()> {
    let session = string(batch, "session")?;
    if !session.starts_with("arn:aws:gamelift:") && !session.starts_with("test:") {
        return Err("invalid source".into());
    }
    let after = batch["after"].as_i64().ok_or("invalid cursor")?;
    let through = batch["through"].as_i64().ok_or("invalid cursor")?;
    if after < 0 || through < after {
        return Err("invalid cursor".into());
    }
    db.conn.execute_batch("CREATE TABLE IF NOT EXISTS cluster_cursors(session TEXT PRIMARY KEY,through INTEGER NOT NULL);")?;
    let tx = db.conn.transaction()?;
    let cursor: i64 = tx.query_row(
        "SELECT coalesce((SELECT through FROM cluster_cursors WHERE session=?1),0)",
        [session],
        |r| r.get(0),
    )?;
    if through < cursor {
        return Ok(());
    }
    if after > cursor {
        return Err("replication gap".into());
    }
    let tables = &batch["tables"];
    if records(tables, "lobbies")?
        .iter()
        .any(|r| r["id"] != session)
    {
        return Err("wrong source lobby".into());
    }
    for p in records(tables, "players")? {
        let id = string(p, "id")?;
        uuid::Uuid::parse_str(id)?;
        // Tokens never cross this replication boundary. Human accounts must
        // already exist in the directory; only authoritative bots are imported.
        if p["is_bot"] == 1 {
            tx.execute("INSERT OR IGNORE INTO players(id,credential_hash,display_name,created_at,last_seen,is_bot,bot_key) VALUES(?1,?2,?3,?4,?5,1,?6)",params![id,format!("bot:{id}"),string(p,"display_name")?,p["created_at"].as_i64(),p["last_seen"].as_i64(),p["bot_key"].as_str()])?;
        } else {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM players WHERE id=?1 AND is_bot=0)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err("unknown human identity".into());
            }
        }
        let key = if p["is_bot"] == 1 {
            None
        } else {
            db::register_name(
                &tx,
                string(p, "display_name")?,
                p["last_seen"].as_i64().ok_or("invalid timestamp")?,
            )?
        };
        tx.execute("UPDATE players SET display_name=CASE WHEN last_seen<=?2 THEN ?3 ELSE display_name END,name_key=CASE WHEN last_seen<=?2 THEN ?4 ELSE name_key END,last_seen=max(last_seen,?2) WHERE id=?1",params![id,p["last_seen"].as_i64(),string(p,"display_name")?,key])?;
    }
    for table in TABLES {
        let columns = {
            let mut s = tx.prepare(&format!("PRAGMA table_info({table})"))?;
            s.query_map([], |r| r.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let columns = columns
            .into_iter()
            .filter(|c| *table != "events" || c != "seq")
            .collect::<Vec<_>>();
        let update = columns
            .iter()
            .filter(|c| c.as_str() != "id")
            .map(|c| format!("{c}=excluded.{c}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "INSERT INTO {table}({}) VALUES({}) ON CONFLICT DO {}",
            columns.join(","),
            vec!["?"; columns.len()].join(","),
            if *table == "events" || *table == "combat_events" || *table == "chat_messages" {
                "NOTHING".to_owned()
            } else {
                format!("UPDATE SET {update}")
            }
        );
        for row in records(tables, table)? {
            if let Some(lobby) = row.get("lobby_id").and_then(Value::as_str) {
                if lobby != session {
                    return Err("cross-lobby record".into());
                }
            }
            let values = columns
                .iter()
                .map(|c| match row.get(c) {
                    Some(Value::Null) => Ok(SqlValue::Null),
                    Some(Value::String(v)) => Ok(SqlValue::Text(v.clone())),
                    Some(Value::Number(v)) => {
                        v.as_i64().map(SqlValue::Integer).ok_or("invalid integer")
                    }
                    _ => Err("invalid record"),
                })
                .collect::<Result<Vec<_>, _>>()?;
            tx.execute(&sql, params_from_iter(values))?;
        }
    }
    for name in records(tables, "names")? {
        super::db::register_name(
            &tx,
            string(name, "display_name")?,
            name["first_seen"].as_i64().ok_or("invalid timestamp")?,
        )?;
    }
    for score in records(tables, "scores")? {
        let key = string(score, "name_key")?;
        let name = records(tables, "names")?
            .iter()
            .find(|n| n["name_key"] == key)
            .ok_or("missing score name")?;
        super::db::record_score(
            &tx,
            string(score, "combat_id")?,
            string(score, "player_id")?,
            string(score, "role")?,
            string(name, "display_name")?,
            score["created_at"].as_i64().ok_or("invalid timestamp")?,
        )?;
    }
    tx.execute("INSERT INTO cluster_cursors(session,through) VALUES(?1,?2) ON CONFLICT(session) DO UPDATE SET through=excluded.through",params![session,through])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn regional_events_retry_without_duplicate_scores_or_changing_credentials() {
        let files = tempfile::tempdir().unwrap();
        let central_path = files.path().join("central.sqlite");
        let mut central = Db::open(&central_path).unwrap();
        let mut remote = Db::open(&files.path().join("remote.sqlite")).unwrap();
        let (player, token) = central.session(None).unwrap().unwrap();
        remote
            .conn
            .execute(
                "INSERT INTO players(id,credential_hash,created_at,last_seen) VALUES(?1,?2,0,0)",
                params![player, db::hash(&"b".repeat(64))],
            )
            .unwrap();
        remote.set_name(&player, "Alice").unwrap();
        let bot = remote.ensure_bot("test:ca:1", "[AI] Carter").unwrap();
        remote.create_lobby("test:ca", "California").unwrap();
        remote.create_match("round-ca", "test:ca", 1).unwrap();
        remote
            .kill(
                "test:ca",
                "round-ca",
                &player,
                &bot,
                "rifle",
                true,
                json!({}),
            )
            .unwrap();
        let first = export(&remote, "test:ca", 0).unwrap();
        assert!(!first.to_string().contains("credential_hash"));
        import(&mut central, &first).unwrap();
        import(&mut central, &first).unwrap();
        assert_eq!(central.authenticate(&token).unwrap(), Some(player.clone()));
        assert_eq!(
            central.leaderboard(db::now_ms()).unwrap().all_time[0].kills,
            1
        );
        assert_eq!(
            central
                .conn
                .query_row("SELECT name_key FROM players WHERE id=?1", [&player], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "alice"
        );
        remote.set_name(&player, "Caroline").unwrap();
        remote
            .kill(
                "test:ca",
                "round-ca",
                &bot,
                &player,
                "rifle",
                false,
                json!({}),
            )
            .unwrap();
        let next = export(&remote, "test:ca", first["through"].as_i64().unwrap()).unwrap();
        import(&mut central, &next).unwrap();
        import(&mut central, &first).unwrap();
        let board = central.leaderboard(db::now_ms()).unwrap();
        assert_eq!(
            board
                .all_time
                .iter()
                .map(|r| (r.name.as_str(), r.kills, r.deaths))
                .collect::<Vec<_>>(),
            vec![("Alice", 1, 0), ("Caroline", 0, 1)]
        );
        assert_eq!(board.last24_hours[1].deaths, 1);
        // A second location can overlap a reconnect grace period. Opening the
        // database again must not recreate the obsolete global unique index.
        central.create_lobby("test:ny", "New York").unwrap();
        for (id, lobby) in [("visit-ca", "test:ca"), ("visit-ny", "test:ny")] {
            central.conn.execute("INSERT INTO memberships(id,lobby_id,player_id,actor_id,name_at_join,faction,joined_at) VALUES(?1,?2,?3,1,'Caroline','british',1)",params![id,lobby,player]).unwrap();
        }
        drop(central);
        let central = Db::open(&central_path).unwrap();
        assert_eq!(central.authenticate(&token).unwrap(), Some(player));
        assert_eq!(
            central
                .conn
                .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }
    #[test]
    fn a_missing_batch_or_foreign_lobby_rolls_back_the_import() {
        let files = tempfile::tempdir().unwrap();
        let mut central = Db::open(&files.path().join("central.sqlite")).unwrap();
        let remote = Db::open(&files.path().join("remote.sqlite")).unwrap();
        remote.create_lobby("test:ca", "California").unwrap();
        let mut batch = export(&remote, "test:ca", 0).unwrap();
        batch["after"] = json!(5);
        batch["through"] = json!(6);
        assert!(import(&mut central, &batch).is_err());
        batch["after"] = json!(0);
        batch["tables"]["lobbies"][0]["id"] = json!("test:ny");
        assert!(import(&mut central, &batch).is_err());
        assert_eq!(
            central
                .conn
                .query_row("SELECT count(*) FROM lobbies", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
