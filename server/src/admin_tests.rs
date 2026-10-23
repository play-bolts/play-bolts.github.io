use super::*;
use crate::{
    hub::{Config, Hub},
    sim::Faction,
    transport,
};
use tokio::sync::{Mutex, watch};
const KEY: &str = "local-test-admin-key-with-at-least-32-characters";
struct Server {
    state: Shared,
    url: String,
    task: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}
impl Server {
    async fn new(key: Option<&str>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(Config {
            bind: "127.0.0.1:0".into(),
            database: dir.path().join("test.sqlite"),
            origins: vec!["https://play-bolts.github.io".into()],
            identity_salt: "local-admin-test-identity-salt-32-bytes".into(),
            empty_seconds: 300.0,
            reconnect_seconds: 30.0,
            max_rooms: 4,
            proxy: false,
        })
        .unwrap();
        let state = Arc::new(Mutex::new(hub));
        let router = router_with_key(state.clone(), key);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            state,
            url,
            task,
            _dir: dir,
        }
    }
    fn query(&self, body: Value) -> reqwest::RequestBuilder {
        reqwest::Client::new()
            .post(format!("{}/api/admin/query", self.url))
            .bearer_auth(KEY)
            .json(&body)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[tokio::test]
async fn auth_is_required_before_sql_or_body_parsing_and_responses_are_not_cached() {
    let server = Server::new(Some(KEY)).await;
    let client = reqwest::Client::new();
    for token in [
        None,
        Some("wrong"),
        Some("another-long-but-incorrect-admin-key-12345"),
    ] {
        let mut request = client
            .post(format!("{}/api/admin/query?key={KEY}", server.url))
            .header("content-type", "application/json")
            .body("malformed");
        if let Some(key) = token {
            request = request.bearer_auth(key);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), 401);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    let duplicate = client
        .get(format!("{}/api/admin/status", server.url))
        .header("authorization", format!("Bearer {KEY}"))
        .header("authorization", format!("Bearer {KEY}"))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), 401);
    let forbidden = server
        .query(json!({"sql":"SELECT 1"}))
        .header("origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), 403);
    for key in [None, Some("too-short"), Some("")] {
        let disabled = Server::new(key).await;
        assert_eq!(
            disabled
                .query(json!({"sql":"SELECT 1"}))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
    }
}
#[tokio::test]
async fn parameterized_reads_preserve_columns_types_and_report_truncation() {
    let server = Server::new(Some(KEY)).await;
    let response=server.query(json!({"sql":"SELECT ? AS number, ? AS text, NULL AS empty_value, x'0102' AS bytes","parameters":[42,"<literal>"]})).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["rows"], json!([[42,"<literal>",null,{"hex":"0102"}]]));
    assert_eq!(
        value["columns"],
        json!(["number", "text", "empty_value", "bytes"])
    );
    assert_eq!(value["truncated"], false);
    let limited:Value=server.query(json!({"sql":"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10) SELECT x FROM n","maxRows":3})).send().await.unwrap().json().await.unwrap();
    assert_eq!(limited["rows"], json!([[1], [2], [3]]));
    assert_eq!(limited["truncated"], true);
}
#[tokio::test]
async fn write_attach_pragma_extension_and_multiple_statements_are_rejected_without_changes() {
    let server = Server::new(Some(KEY)).await;
    for sql in [
        "DELETE FROM players",
        "UPDATE players SET display_name='changed'",
        "INSERT INTO players(id,credential_hash,created_at,last_seen) VALUES('x','x',1,1)",
        "CREATE TEMP TABLE x(a)",
        "DROP TABLE players",
        "ATTACH DATABASE ':memory:' AS other",
        "PRAGMA query_only=OFF",
        "VACUUM",
        "BEGIN",
        "SELECT load_extension('bad')",
        "SELECT 1; SELECT 2",
        "SELECT writefile('/tmp/bad','bad')",
    ] {
        let response = server.query(json!({"sql":sql})).send().await.unwrap();
        assert_eq!(response.status(), 400, "{sql}");
    }
    let value: Value = server
        .query(json!({"sql":"SELECT count(*) FROM players"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(value["rows"], json!([[0]]));
    let value: Value = server
        .query(json!({"sql":"SELECT 1; -- a harmless trailing comment"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(value["rows"], json!([[1]]));
}
#[tokio::test]
async fn costly_queries_abort_and_admin_reads_do_not_hold_the_hub_mutex() {
    let server = Server::new(Some(KEY)).await;
    let request=server.query(json!({"sql":"WITH RECURSIVE x(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x"}));
    let running = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::sleep(Duration::from_millis(5)).await;
    tokio::time::timeout(Duration::from_millis(100), async {
        server.state.lock().await.tick().unwrap();
    })
    .await
    .expect("query must not lock the game");
    let response = tokio::time::timeout(Duration::from_secs(2), running)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 408);
    assert_eq!(
        server
            .query(json!({"sql":"SELECT randomblob(1000000000)"}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let healthy: Value = server
        .query(json!({"sql":"SELECT 1"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(healthy["rows"], json!([[1]]));
}
#[tokio::test]
async fn input_limits_and_result_bytes_are_bounded() {
    let server = Server::new(Some(KEY)).await;
    for body in [
        json!({"sql":""}),
        json!({"sql":"SELECT 1","maxRows":0}),
        json!({"sql":"SELECT 1","maxRows":501}),
        json!({"sql":"SELECT ?","parameters":[{}]}),
        json!({"sql":"SELECT 1","unknown":true}),
    ] {
        assert!(
            server
                .query(body)
                .send()
                .await
                .unwrap()
                .status()
                .is_client_error()
        );
    }
    let oversized = server
        .query(json!({"sql":"a".repeat(20000)}))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), 413);
    let response=server.query(json!({"sql":"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500) SELECT hex(zeroblob(8000)) FROM n","maxRows":500})).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let body = response.bytes().await.unwrap();
    assert!(body.len() < MAX_BYTES + 4096);
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["truncated"], true);
}
#[tokio::test]
async fn activity_counts_distinct_humans_with_real_connection_membership_overlap() {
    let server = Server::new(Some(KEY)).await;
    let now = db::now_ms();
    let storage = server.state.lock().await.db.clone();
    let player = storage
        .request(|db| Ok(db.session(None)?.unwrap().0))
        .await
        .unwrap();
    let cid = db::id();
    let (tx, _messages) = transport::channel();
    let (cancel, _cancelled) = watch::channel(None);
    {
        let mut hub = server.state.lock().await;
        hub.register(&player, cid.clone(), tx, cancel, "127.0.0.1", "test")
            .unwrap();
        hub.join(&player, &cid, None, "Current", Faction::British, true)
            .unwrap();
    }
    storage.request(move|db|{
  db.conn.execute("INSERT INTO lobbies(id,name,created_at) VALUES('historical','history',?1)",[now-600000])?;
  for (id,opened,closed,joined,left,bot) in [("recent",now-90000,now-10000,now-80000,now-20000,0),("old",now-500000,now-200000,now-400000,now-300000,0),("no-overlap",now-90000,now-70000,now-50000,now-20000,0),("bot",now-50000,now-10000,now-40000,now-20000,1)]{
   db.conn.execute("INSERT INTO players(id,credential_hash,created_at,last_seen,is_bot) VALUES(?1,?1,?2,?2,?3)",rusqlite::params![id,now-600000,bot])?;
   db.conn.execute("INSERT INTO connections(id,player_id,opened_at,closed_at,ip_hash,ua_hash) VALUES(?1,?1,?2,?3,'x','x')",rusqlite::params![id,opened,closed])?;
   db.conn.execute("INSERT INTO memberships(id,lobby_id,player_id,actor_id,name_at_join,faction,joined_at,left_at) VALUES(?1,'historical',?1,1,'test','british',?2,?3)",rusqlite::params![id,joined,left])?;
  }
  db.record_visit(&uuid::Uuid::new_v4(),now-10000)?;db.record_visit(&uuid::Uuid::new_v4(),now-110000)?;db.record_visit(&uuid::Uuid::new_v4(),now-500000)?;
  Ok(())
 }).await.unwrap();
    let client = reqwest::Client::new();
    let value: Value = client
        .get(format!("{}/api/admin/status?minutes=2", server.url))
        .bearer_auth(KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(value["activeNow"], 1);
    assert_eq!(value["activePastMinutes"], 2);
    assert_eq!(value["browsersLast90Seconds"], 1);
    assert_eq!(value["browsersPastMinutes"], 2);
    for minutes in ["0", "10081", "-1", "abc"] {
        assert_eq!(
            client
                .get(format!("{}/api/admin/status?minutes={minutes}", server.url))
                .bearer_auth(KEY)
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
    }
}
#[test]
fn dotenv_key_loading_is_narrow_and_accepts_generated_secret_format() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env");
    assert_eq!(dotenv_key(&path), None);
    std::fs::write(
        &path,
        format!("# private\nUNRELATED=ignored\nexport BOLTS_ADMIN_API_KEY='{KEY}'\n"),
    )
    .unwrap();
    assert_eq!(dotenv_key(&path).as_deref(), Some(KEY));
    assert!(key_tag(Some(KEY)).is_some());
    assert!(key_tag(Some("short")).is_none());
    assert!(key_tag(Some(&"x".repeat(129))).is_none());
}

#[tokio::test]
async fn sql_quota_does_not_block_status_or_gameplay() {
    let server = Server::new(Some(KEY)).await;
    for _ in 0..30 {
        assert_eq!(
            server
                .query(json!({"sql":"SELECT 1"}))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    let limited = server
        .query(json!({"sql":"SELECT 1"}))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), 429);
    assert_eq!(limited.headers()["cache-control"], "no-store");
    assert_eq!(
        reqwest::Client::new()
            .get(format!("{}/api/admin/status", server.url))
            .bearer_auth(KEY)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    server.state.lock().await.tick().unwrap();
}

#[tokio::test]
async fn simultaneous_reads_are_bounded_and_release_slots_when_finished() {
    let server = Server::new(Some(KEY)).await;
    let state = AdminState {
        database: server.state.lock().await.config.database.clone(),
        hub: server.state.clone(),
        key_tag: key_tag(Some(KEY)),
        slots: Arc::new(Semaphore::new(2)),
    };
    let mut pending = Vec::new();
    for _ in 0..2 {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let copy = state.clone();
        let task = tokio::spawn(read(copy, move |_| {
            started.send(()).unwrap();
            blocked.recv_timeout(Duration::from_secs(2)).unwrap();
            Ok(json!({"ok":true}))
        }));
        ready.await.unwrap();
        pending.push((release, task));
    }
    assert_eq!(read(state.clone(), |_| Ok(json!({}))).await.status(), 429);
    for (release, task) in pending {
        release.send(()).unwrap();
        assert_eq!(task.await.unwrap().status(), 200);
    }
    assert_eq!(read(state, |_| Ok(json!({}))).await.status(), 200);
}
