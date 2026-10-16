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
