use super::visitors::{SinglePlayerEvent, StopReason, VisitEvent};
use super::*;

fn database() -> (tempfile::TempDir, Db) {
    let directory = tempfile::tempdir().unwrap();
    let db = Db::open(&directory.path().join("visits.sqlite")).unwrap();
    (directory, db)
}

fn count(db: &Db, table: &str) -> i64 {
    db.conn
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn repeated_visits_coalesce_by_minute_and_keep_first_and_last_times() {
    let (_directory, mut db) = database();
    let visitor = Uuid::new_v4();
    for at in [
        120_001, 120_001, 120_100, 120_050, 120_000, 179_999, 180_000,
    ] {
        db.record_visit(&visitor, at).unwrap();
    }
    assert_eq!(count(&db, "visitors"), 1);
    assert_eq!(
        db.conn
            .query_row("SELECT first_seen,last_seen FROM visitors", [], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })
            .unwrap(),
        (120_000, 180_000)
    );
    let rows = db
        .conn
        .prepare(
            "SELECT bucket_start,first_seen,last_seen FROM visitor_activity ORDER BY bucket_start",
        )
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![(120_000, 120_000, 179_999), (180_000, 180_000, 180_000)]
    );
    db.record_visit(&Uuid::new_v4(), 120_100).unwrap();
    assert_eq!(count(&db, "visitors"), 2);
    assert_eq!(count(&db, "visitor_activity"), 3);
}

#[test]
fn visitor_writes_have_no_player_or_game_side_effects_or_private_columns() {
    let (_directory, mut db) = database();
    let tables = [
        "players",
        "connections",
        "events",
        "combat_events",
        "leaderboard_names",
        "leaderboard_events",
    ];
    let before = tables.map(|table| count(&db, table));
    db.record_visit(&Uuid::new_v4(), 1_234_567).unwrap();
    assert_eq!(tables.map(|table| count(&db, table)), before);
    for (table, expected) in [
        ("visitors", vec!["id", "first_seen", "last_seen"]),
        (
            "visitor_activity",
            vec!["visitor_id", "bucket_start", "first_seen", "last_seen"],
        ),
    ] {
        let columns = db
            .conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(columns, expected);
    }
    assert_eq!(db.conn.query_row("SELECT count(*) FROM sqlite_master WHERE name='visitor_activity_time' AND type='index'", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
}

#[test]
fn failed_bucket_write_rolls_back_the_visitor_upsert() {
    let (_directory, mut db) = database();
    let visitor = Uuid::new_v4();
    db.record_visit(&visitor, 100).unwrap();
    db.conn.execute_batch("CREATE TRIGGER reject_visitor_activity BEFORE INSERT ON visitor_activity BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(db.record_visit(&visitor, 200).is_err());
    assert!(db.record_visit(&Uuid::new_v4(), 200).is_err());
    assert_eq!(count(&db, "visitors"), 1);
    assert_eq!(
        db.conn
            .query_row("SELECT last_seen FROM visitors", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        100
    );
    assert_eq!(
        db.conn
            .query_row("SELECT last_seen FROM visitor_activity", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        100
    );
}

#[test]
fn invalid_ids_and_times_are_rejected_at_database_boundary() {
    let (_directory, mut db) = database();
    assert!(db.record_visit(&Uuid::nil(), 1).is_err());
    assert!(db.record_visit(&Uuid::new_v4(), -1).is_err());
    assert_eq!(count(&db, "visitors"), 0);
    assert_eq!(count(&db, "visitor_activity"), 0);
}

#[test]
fn migration_three_is_additive_and_reopening_preserves_data() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("old.sqlite");
    let conn = Connection::open(&path).unwrap();
    let old_schema = include_str!("../schema.sql")
        .split("-- Anonymous site visits")
        .next()
        .unwrap();
    conn.execute_batch(old_schema).unwrap();
    conn.execute("INSERT INTO schema_migrations VALUES(2,1)", [])
        .unwrap();
    conn.execute("INSERT INTO players(id,credential_hash,display_name,created_at,last_seen) VALUES('existing','preserved-credential','Existing Player',1,2)", []).unwrap();
    conn.execute(
        "INSERT INTO leaderboard_names VALUES('existing player','Existing Player',1,2,25,7)",
        [],
    )
    .unwrap();
    drop(conn);
    let mut db = Db::open(&path).unwrap();
    assert_eq!(
        db.conn
            .query_row(
                "SELECT credential_hash FROM players WHERE id='existing'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "preserved-credential"
    );
    assert_eq!(
        db.conn
            .query_row("SELECT kills,deaths FROM leaderboard_names", [], |r| Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?
            )))
            .unwrap(),
        (25, 7)
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM schema_migrations WHERE version=3",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    let visitor = Uuid::new_v4();
    db.record_visit(&visitor, 60_001).unwrap();
    drop(db);
    let db = Db::open(&path).unwrap();
    assert_eq!(count(&db, "visitors"), 1);
    assert_eq!(count(&db, "visitor_activity"), 1);
    assert_eq!(
        db.conn
            .query_row("SELECT kills FROM leaderboard_names", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        25
    );
}

#[test]
fn migration_failure_rolls_back_new_tables_and_marker() {
    let conn = Connection::open_in_memory().unwrap();
    let schema = include_str!("../schema.sql");
    conn.execute_batch(schema.split("-- Anonymous site visits").next().unwrap())
        .unwrap();
    // Incompatible preexisting table forces the new index to fail. No partial
    // visitors table or successful migration marker may survive the rollback.
    conn.execute_batch("CREATE TABLE visitor_activity(unrelated TEXT);")
        .unwrap();
    let migration = schema.split("-- Anonymous site visits").nth(1).unwrap();
    let migration = format!("-- Anonymous site visits{migration}");
    assert!(conn.execute_batch(&migration).is_err());
    conn.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='visitors'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM schema_migrations WHERE version=3",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn network_observations_are_canonicalized_and_lifecycle_retries_are_idempotent() {
    let (_directory, mut db) = database();
    let existing_events = count(&db, "events");
    let visitor = Uuid::new_v4();
    let session = Uuid::new_v4();
    let start = SinglePlayerEvent {
        session_id: session,
        event: VisitEvent::SinglePlayerStart,
        reason: None,
    };
    let stop = SinglePlayerEvent {
        event: VisitEvent::SinglePlayerStop,
        reason: Some(StopReason::Quit),
        ..start
    };
    let mapped = "::ffff:192.0.2.1".parse().unwrap();
    let plain = "192.0.2.1".parse().unwrap();
    db.record_visitor_activity(&visitor, Some(mapped), Some(&start), 100)
        .unwrap();
    db.record_visitor_activity(&visitor, Some(plain), Some(&stop), 200)
        .unwrap();
    db.record_visitor_activity(&visitor, Some(plain), Some(&start), 300)
        .unwrap();
    db.record_visitor_activity(&visitor, Some(plain), Some(&stop), 400)
        .unwrap();
    db.record_visitor_activity(&visitor, Some(plain), None, 50)
        .unwrap();
    assert_eq!(count(&db, "visitor_networks"), 1);
    assert_eq!(count(&db, "single_player_events"), 2);
    assert_eq!(
        db.conn
            .query_row(
                "SELECT ip_address,first_seen,last_seen FROM visitor_networks",
                [],
                |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?
                ))
            )
            .unwrap(),
        ("192.0.2.1".into(), 50, 400)
    );
    assert_eq!(db.conn.query_row("SELECT at,ip_address,reason FROM single_player_events WHERE event='single_player_stop'", [], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap(), (200,"192.0.2.1".into(),"quit".into()));
    assert_eq!(
        db.conn
            .query_row(
                "SELECT at FROM single_player_events WHERE event='single_player_start'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        100
    );
    // Distinct tabs can play independently, while unknown peers stay unknown.
    let second = SinglePlayerEvent {
        session_id: Uuid::new_v4(),
        ..start
    };
    db.record_visitor_activity(&visitor, None, Some(&second), 500)
        .unwrap();
    assert_eq!(count(&db, "single_player_events"), 3);
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM single_player_events WHERE ip_address IS NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(count(&db, "players"), 0);
    assert_eq!(count(&db, "events"), existing_events);
}

#[test]
fn lifecycle_failures_roll_back_receipts_and_network_observations_together() {
    let (_directory, mut db) = database();
    let visitor = Uuid::new_v4();
    let start = SinglePlayerEvent {
        session_id: Uuid::new_v4(),
        event: VisitEvent::SinglePlayerStart,
        reason: None,
    };
    db.conn.execute_batch("CREATE TRIGGER reject_local_event BEFORE INSERT ON single_player_events BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(
        db.record_visitor_activity(
            &visitor,
            Some("192.0.2.1".parse().unwrap()),
            Some(&start),
            100
        )
        .is_err()
    );
    for table in [
        "visitors",
        "visitor_activity",
        "visitor_networks",
        "single_player_events",
    ] {
        assert_eq!(count(&db, table), 0, "{table} must roll back");
    }
    let invalid = SinglePlayerEvent {
        session_id: Uuid::nil(),
        ..start
    };
    assert!(
        db.record_visitor_activity(&visitor, None, Some(&invalid), 100)
            .is_err()
    );
    let invalid = SinglePlayerEvent {
        reason: Some(StopReason::Quit),
        ..start
    };
    assert!(
        db.record_visitor_activity(&visitor, None, Some(&invalid), 100)
            .is_err()
    );
}

#[test]
fn lifecycle_schema_enforces_types_reasons_timestamps_and_foreign_keys() {
    let (_directory, mut db) = database();
    let visitor = Uuid::new_v4();
    db.record_visit(&visitor, 1).unwrap();
    let session = Uuid::new_v4().to_string();
    for (id, event, at, reason) in [
        (session.as_str(), "arbitrary", 1, None),
        (session.as_str(), "single_player_start", 1, Some("quit")),
        (
            session.as_str(),
            "single_player_stop",
            1,
            Some("private free text"),
        ),
        (session.as_str(), "single_player_start", -1, None),
        (
            "00000000-0000-0000-0000-000000000000",
            "single_player_start",
            1,
            None,
        ),
        (
            "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz",
            "single_player_start",
            1,
            None,
        ),
    ] {
        assert!(db.conn.execute("INSERT INTO single_player_events(visitor_id,session_id,event,at,reason) VALUES(?1,?2,?3,?4,?5)",params![visitor.to_string(),id,event,at,reason]).is_err());
    }
    assert!(db.conn.execute("INSERT INTO single_player_events(visitor_id,session_id,event,at) VALUES('missing',?1,'single_player_start',1)",[session]).is_err());
    assert_eq!(count(&db, "single_player_events"), 0);
}

#[test]
fn migration_five_preserves_prior_visits_without_inventing_ips_or_local_play() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("previous.sqlite");
    let conn = Connection::open(&path).unwrap();
    let previous_schema = include_str!("../schema.sql")
        .split("-- Private first-party network")
        .next()
        .unwrap();
    conn.execute_batch(previous_schema).unwrap();
    conn.execute("INSERT OR IGNORE INTO schema_migrations VALUES(2,1)", [])
        .unwrap();
    let visitor = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO visitors VALUES(?1,100,200)", [&visitor])
        .unwrap();
    conn.execute(
        "INSERT INTO visitor_activity VALUES(?1,0,100,200)",
        [&visitor],
    )
    .unwrap();
    drop(conn);
    for _ in 0..2 {
        let db = Db::open(&path).unwrap();
        assert_eq!(count(&db, "visitors"), 1);
        assert_eq!(count(&db, "visitor_activity"), 1);
        assert_eq!(count(&db, "visitor_networks"), 0);
        assert_eq!(count(&db, "single_player_events"), 0);
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM schema_migrations WHERE version=5",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
}

#[test]
fn migration_five_failure_rolls_back_new_private_tables_and_marker() {
    let conn = Connection::open_in_memory().unwrap();
    let schema = include_str!("../schema.sql");
    conn.execute_batch(
        schema
            .split("-- Private first-party network")
            .next()
            .unwrap(),
    )
    .unwrap();
    conn.execute_batch("CREATE TABLE single_player_events(unrelated TEXT)")
        .unwrap();
    let migration = schema
        .split("-- Private first-party network")
        .nth(1)
        .unwrap();
    assert!(
        conn.execute_batch(&format!("-- Private first-party network{migration}"))
            .is_err()
    );
    conn.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='visitor_networks'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM schema_migrations WHERE version=5",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
