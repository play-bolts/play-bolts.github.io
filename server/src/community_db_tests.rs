use super::*;

fn database() -> (tempfile::TempDir, Db) {
    let directory = tempfile::tempdir().unwrap();
    let db = Db::open(&directory.path().join("events.sqlite")).unwrap();
    (directory, db)
}
fn player(db: &mut Db, name: &str) -> String {
    let (player, _) = db.session(None).unwrap().unwrap();
    db.set_name(&player, name).unwrap();
    player
}
fn combat(db: &mut Db, killer: &str, victim: &str) {
    db.kill("l", "m", killer, victim, "rifle", false, json!({}))
        .unwrap();
}
fn arena(db: &Db) {
    db.create_lobby("l", "Rommel Alpha").unwrap();
    db.create_match("m", "l", 1).unwrap();
}

#[test]
fn names_are_indexed_grouped_and_scored_at_combat_time_without_bots_or_defaults() {
    let (_directory, mut db) = database();
    arena(&db);
    let alice = player(&mut db, " ^2Alice   Smith ");
    let same_name = player(&mut db, "^9ALICE Smith");
    let bob = player(&mut db, "Bob");
    let unknown = player(&mut db, " ^7Unknown  Soldier ");
    let bot = db.ensure_bot("test-bot", "[AI] Carter").unwrap();
    assert_eq!(bot, db.ensure_bot("test-bot", "[AI] Carter").unwrap());
    combat(&mut db, &alice, &bot);
    combat(&mut db, &same_name, &unknown);
    combat(&mut db, &bot, &alice);
    combat(&mut db, &unknown, &bot);
    db.set_name(&alice, "Caroline").unwrap();
    combat(&mut db, &alice, &bob);
    let board = db.leaderboard(now_ms()).unwrap();
    let names = board
        .all_time
        .iter()
        .map(|r| (r.name.as_str(), r.kills, r.deaths))
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![("Alice Smith", 2, 1), ("Caroline", 1, 0), ("Bob", 0, 1)]
    );
    assert_eq!(board.last24_hours.len(), 3);
    assert_eq!(
        db.conn
            .query_row(
                "SELECT name_key FROM players WHERE id=?1",
                [&same_name],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "alice smith"
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='players_name_key'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(db.authenticate(&"0".repeat(64)).unwrap().is_none());
    assert!(
        db.conn
            .query_row("SELECT name_key FROM players WHERE id=?1", [bot], |r| {
                r.get::<_, Option<String>>(0)
            })
            .unwrap()
            .is_none()
    );
}

#[test]
fn rolling_window_counts_kills_and_deaths_and_has_stable_ties() {
    let (_directory, mut db) = database();
    arena(&db);
    let alpha = player(&mut db, "Alpha");
    let beta = player(&mut db, "Beta");
    player(&mut db, "Charlie");
    combat(&mut db, &alpha, &beta);
    let at = now_ms();
    db.conn
        .execute(
            "UPDATE leaderboard_events SET created_at=?1",
            [at - 86_400_001],
        )
        .unwrap();
    combat(&mut db, &beta, &alpha);
    db.conn
        .execute(
            "UPDATE leaderboard_events SET created_at=?1 WHERE created_at>?2",
            params![at - 86_400_000, at - 86_400_001],
        )
        .unwrap();
    let board = db.leaderboard(at).unwrap();
    assert_eq!(
        board
            .all_time
            .iter()
            .map(|r| (r.name.as_str(), r.kills, r.deaths))
            .collect::<Vec<_>>(),
        vec![("Alpha", 1, 1), ("Beta", 1, 1), ("Charlie", 0, 0)]
    );
    assert_eq!(
        board
            .last24_hours
            .iter()
            .map(|r| (r.name.as_str(), r.kills, r.deaths))
            .collect::<Vec<_>>(),
        vec![("Beta", 1, 0), ("Charlie", 0, 0), ("Alpha", 0, 1)]
    );
    let later = db.leaderboard(at + 1).unwrap();
    assert!(
        later
            .last24_hours
            .iter()
            .all(|r| r.kills == 0 && r.deaths == 0)
    );
    let wire = serde_json::to_value(board).unwrap();
    assert!(wire["allTime"].is_array());
    assert!(wire["last24Hours"].is_array());
}

#[test]
fn legacy_schema_migrates_and_historical_names_backfill_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let legacy = Connection::open(&path).unwrap();
    legacy.execute_batch("CREATE TABLE players(id TEXT PRIMARY KEY,credential_hash TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL DEFAULT 'Player',created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL);INSERT INTO players VALUES('legacy','legacyhash','^3Legacy',0,0);").unwrap();
    drop(legacy);
    let mut db = Db::open(&path).unwrap();
    arena(&db);
    let victim = player(&mut db, "Victim");
    db.event(EventRow {
        kind: "profile_change",
        lobby: Some("l"),
        game: Some("m"),
        connection: None,
        actor: Some("legacy"),
        target: None,
        data: json!({"name":"^2Earlier"}),
    })
    .unwrap();
    db.set_name("legacy", "Earlier").unwrap();
    combat(&mut db, "legacy", &victim);
    combat(&mut db, "legacy", "legacy");
    db.event(EventRow {
        kind: "profile_change",
        lobby: Some("l"),
        game: Some("m"),
        connection: None,
        actor: Some("legacy"),
        target: None,
        data: json!({"name":"Later"}),
    })
    .unwrap();
    db.set_name("legacy", "Later").unwrap();
    db.conn.execute_batch("DELETE FROM leaderboard_events;DELETE FROM leaderboard_names;DELETE FROM schema_migrations WHERE version=2;").unwrap();
    drop(db);
    for _ in 0..2 {
        let db = Db::open(&path).unwrap();
        let board = db.leaderboard(now_ms()).unwrap();
        assert_eq!(
            board
                .all_time
                .iter()
                .find(|r| r.name == "Earlier")
                .unwrap()
                .kills,
            1
        );
        assert_eq!(
            board
                .all_time
                .iter()
                .find(|r| r.name == "Later")
                .unwrap()
                .kills,
            0
        );
        assert_eq!(board.all_time.iter().map(|r| r.kills).sum::<i64>(), 1);
        assert_eq!(
            board
                .all_time
                .iter()
                .find(|r| r.name == "Earlier")
                .unwrap()
                .deaths,
            1,
            "self-death backfills once without awarding a kill"
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM combat_events", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            db.conn
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }
}

#[test]
fn feedback_is_private_atomic_parameterized_and_rate_limited_across_restart() {
    let (directory, mut db) = database();
    let text = "'); DROP TABLE players; -- <script>feedback</script>";
    for i in 0..5 {
        let request = db
            .feedback(text, Some("qa+feedback@example.org"), "keyed-ip")
            .unwrap()
            .unwrap();
        assert!(Uuid::parse_str(&request).is_ok());
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM feedback_events WHERE request_id=?1",
                    [request],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM feedback_requests", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            i + 1
        );
    }
    drop(db);
    let mut db = Db::open(&directory.path().join("events.sqlite")).unwrap();
    assert!(
        db.feedback("over limit", None, "keyed-ip")
            .unwrap()
            .is_none()
    );
    assert!(
        db.feedback("another network", None, "other-keyed-ip")
            .unwrap()
            .is_some()
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT message FROM feedback_requests WHERE ip_hash='keyed-ip' LIMIT 1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        text
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM events WHERE data LIKE '%example.org%'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert!(db.session(None).unwrap().is_some());
}

#[test]
fn default_name_is_not_retroactively_credited_when_renamed() {
    let (_directory, mut db) = database();
    arena(&db);
    let unknown = player(&mut db, "Unknown Soldier");
    let target = player(&mut db, "Target");
    combat(&mut db, &unknown, &target);
    db.set_name(&unknown, "New Name").unwrap();
    let board = db.leaderboard(now_ms()).unwrap();
    assert_eq!(
        board
            .all_time
            .iter()
            .find(|r| r.name == "New Name")
            .unwrap()
            .kills,
        0
    );
    let tricky = player(&mut db, "x'); DELETE FROM players;--");
    combat(&mut db, &tricky, &target);
    assert_eq!(
        db.leaderboard(now_ms()).unwrap().all_time[0].name,
        "x'); DELETE FROM players;--"
    );
}
