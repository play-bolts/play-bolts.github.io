use super::*;
use crate::hub::Config;

const ORIGIN: &str = "https://play-bolts.github.io";

struct Server {
    state: Shared,
    url: String,
    task: tokio::task::JoinHandle<()>,
    _directory: tempfile::TempDir,
}
impl Server {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(Mutex::new(
            Hub::new(Config {
                bind: "127.0.0.1:0".into(),
                database: directory.path().join("visits.sqlite"),
                origins: vec![ORIGIN.into()],
                identity_salt: "visitor-test-salt-with-at-least-32-chars".into(),
                empty_seconds: 300.0,
                reconnect_seconds: 30.0,
                max_rooms: 4,
                proxy: false,
            })
            .unwrap(),
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let service = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
        let task = tokio::spawn(async move {
            axum::serve(listener, service).await.unwrap();
        });
        Self {
            state,
            url,
            task,
            _directory: directory,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn visits_require_one_exact_allowed_origin_and_allow_browser_preflight() {
    let server = Server::new().await;
    let client = reqwest::Client::new();
    let endpoint = format!("{}/api/visits", server.url);
    for origins in [
        vec![],
        vec!["https://evil.example"],
        vec!["null"],
        vec!["https://play-bolts.github.io/"],
        vec![ORIGIN, ORIGIN],
    ] {
        let mut request = client
            .post(&endpoint)
            .json(&json!({"visitorId":uuid::Uuid::new_v4()}));
        for origin in origins {
            request = request.header("origin", origin);
        }
        assert_eq!(
            request.send().await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let missing = client
        .post(&endpoint)
        .header("content-type", "application/json")
        .body("malformed")
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::FORBIDDEN);
    let preflight = client
        .request(reqwest::Method::OPTIONS, &endpoint)
        .header("origin", ORIGIN)
        .header("access-control-request-method", "POST")
        .header("access-control-request-headers", "content-type")
        .send()
        .await
        .unwrap();
    assert!(preflight.status().is_success());
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        ORIGIN
    );
    let response = client
        .post(&endpoint)
        .header("origin", ORIGIN)
        .json(&json!({"visitorId":uuid::Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        ORIGIN
    );
    assert!(response.bytes().await.unwrap().is_empty());
}

#[tokio::test]
async fn visits_reject_invalid_uuids_unknown_fields_and_oversized_bodies() {
    let server = Server::new().await;
    let client = reqwest::Client::new();
    let endpoint = format!("{}/api/visits", server.url);
    for id in [
        "",
        "not-a-uuid",
        "00000000-0000-0000-0000-000000000000",
        "550e8400-e29b-11d4-a716-446655440000",
        "550e8400-e29b-41d4-7716-446655440000",
        "550e8400e29b41d4a716446655440000",
    ] {
        assert_eq!(
            client
                .post(&endpoint)
                .header("origin", ORIGIN)
                .json(&json!({"visitorId":id}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for body in [
        json!({}),
        json!({"visitorId":3}),
        json!({"visitorId":uuid::Uuid::new_v4(),"at":1}),
        json!({"visitorId":uuid::Uuid::new_v4(),"userAgent":"private"}),
    ] {
        assert_eq!(
            client
                .post(&endpoint)
                .header("origin", ORIGIN)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        client
            .post(&endpoint)
            .header("origin", ORIGIN)
            .json(&json!({"visitorId":"x".repeat(257)}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        server
            .state
            .lock()
            .await
            .db
            .test_conn()
            .query_row("SELECT count(*) FROM visitors", &[], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn visits_are_server_timed_canonicalized_and_limited_per_network() {
    let server = Server::new().await;
    let client = reqwest::Client::new();
    let endpoint = format!("{}/api/visits", server.url);
    let id = uuid::Uuid::new_v4();
    let before = crate::db::now_ms();
    for i in 0..60 {
        let response = client.post(&endpoint).header("origin",ORIGIN)
            .header("user-agent","private-browser-marker")
            .json(&json!({"visitorId":if i == 0 { id.to_string().to_uppercase() } else { id.to_string() }}))
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT, "request {i}");
    }
    let after = crate::db::now_ms();
    // A new UUID cannot bypass the same network's in-memory rate limit.
    let limited = client
        .post(&endpoint)
        .header("origin", ORIGIN)
        .json(&json!({"visitorId":uuid::Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    let h = server.state.lock().await;
    let row =
        h.db.test_conn()
            .query_row("SELECT id,first_seen,last_seen FROM visitors", &[], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .unwrap();
    assert_eq!(row.0, id.to_string());
    assert!(row.1 >= before && row.2 <= after && row.2 >= row.1);
    assert_eq!(
        h.db.test_conn()
            .query_row("SELECT count(*) FROM visitors", &[], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        h.db.test_conn()
            .query_row("SELECT count(*) FROM players", &[], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn visitor_database_failure_does_not_fail_games_or_health() {
    let server = Server::new().await;
    {
        let h = server.state.lock().await;
        h.db.test_conn().execute_batch("CREATE TRIGGER fail_visits BEFORE INSERT ON visitors BEGIN SELECT RAISE(ABORT,'test analytics failure'); END;").unwrap();
    }
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/api/visits", server.url))
        .header("origin", ORIGIN)
        .json(&json!({"visitorId":uuid::Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(!server.state.lock().await.failed);
    assert_eq!(
        client
            .get(format!("{}/api/health", server.url))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // Identity and lobby creation remain operational after analytics failure.
    let session = client
        .post(format!("{}/api/session", server.url))
        .header("origin", ORIGIN)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(session.status(), StatusCode::OK);
}

#[tokio::test]
async fn blocked_visitor_write_does_not_hold_hub_lock_or_stop_snapshot_progress() {
    use std::sync::atomic::Ordering;
    let server = Server::new().await;
    let (storage, database, metrics, _outgoing, _cancelled) = {
        let mut hub = server.state.lock().await;
        let (player, _) = hub.db.session(None).unwrap().unwrap();
        let (outbox, outgoing) = crate::transport::channel();
        let metrics = outbox.metrics.clone();
        let (cancel, cancelled) = watch::channel(None);
        let cid = crate::db::id();
        hub.register(&player, cid.clone(), outbox, cancel, "test", "test")
            .unwrap();
        hub.join(
            &player,
            &cid,
            None,
            "Storage test",
            crate::sim::Faction::British,
            true,
        )
        .unwrap();
        (
            hub.db.clone(),
            hub.config.database.clone(),
            metrics,
            outgoing,
            cancelled,
        )
    };
    storage.request(|_| Ok(())).await.unwrap();
    let lock = rusqlite::Connection::open(database).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let url = format!("{}/api/visits", server.url);
    let request = tokio::spawn(async move {
        reqwest::Client::new()
            .post(url)
            .header("origin", ORIGIN)
            .json(&json!({"visitorId":uuid::Uuid::new_v4()}))
            .send()
            .await
            .unwrap()
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(!request.is_finished(), "SQLite writer is deliberately held");
    let before = Instant::now();
    for _ in 0..18 {
        tokio::time::timeout(Duration::from_millis(100), server.state.lock())
            .await
            .unwrap()
            .tick()
            .unwrap();
    }
    assert!(before.elapsed() < Duration::from_millis(150));
    assert_eq!(metrics.snapshots_published.load(Ordering::Relaxed), 6);
    assert!(
        !request.is_finished(),
        "simulation progressed while persistence still waited"
    );
    lock.execute_batch("ROLLBACK").unwrap();
    assert_eq!(request.await.unwrap().status(), StatusCode::NO_CONTENT);
    storage.drain().await.unwrap();
}

#[tokio::test]
async fn lifecycle_receipts_capture_observed_ip_and_accept_out_of_order_retries() {
    let server = Server::new().await;
    let client = reqwest::Client::new();
    let visitor = uuid::Uuid::new_v4();
    let session = uuid::Uuid::new_v4();
    let before = crate::db::now_ms();
    // Keepalive teardown and ordinary start requests can arrive out of order.
    for (event, reason) in [
        ("single_player_stop", Some("page_exit")),
        ("single_player_start", None),
        ("single_player_stop", Some("quit")),
        ("single_player_start", None),
    ] {
        let mut body = json!({"visitorId":visitor,"sessionId":session.to_string().to_uppercase(),"event":event});
        if let Some(reason) = reason {
            body["reason"] = json!(reason);
        }
        let response = client
            .post(format!("{}/api/visits", server.url))
            .header("origin", ORIGIN)
            .header("x-forwarded-for", "198.51.100.50")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }
    let after = crate::db::now_ms();
    let h = server.state.lock().await;
    assert_eq!(
        h.db.test_conn()
            .query_row("SELECT count(*) FROM single_player_events", &[], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(h.db.test_conn().query_row("SELECT session_id,ip_address,reason FROM single_player_events WHERE event='single_player_stop'",&[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap(),(session.to_string(),"127.0.0.1".into(),"page_exit".into()));
    let times =
        h.db.test_conn()
            .query_row(
                "SELECT min(at),max(at) FROM single_player_events",
                &[],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .unwrap();
    assert!(times.0 >= before && times.1 <= after);
    assert_eq!(
        h.db.test_conn()
            .query_row("SELECT ip_address FROM visitor_networks", &[], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "127.0.0.1"
    );
    assert_eq!(
        h.db.test_conn()
            .query_row("SELECT count(*) FROM players", &[], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn lifecycle_fields_are_bounded_and_cannot_supply_timestamps_or_ips() {
    let server = Server::new().await;
    let client = reqwest::Client::new();
    let endpoint = format!("{}/api/visits", server.url);
    let visitor = uuid::Uuid::new_v4();
    let session = uuid::Uuid::new_v4();
    for fields in [
        json!({"event":"single_player_start"}),
        json!({"sessionId":session}),
        json!({"reason":"quit"}),
        json!({"event":"single_player_start","sessionId":"invalid"}),
        json!({"event":"single_player_start","sessionId":"00000000-0000-0000-0000-000000000000"}),
        json!({"event":"single_player_start","sessionId":session,"reason":"quit"}),
    ] {
        let mut body = json!({"visitorId":visitor});
        body.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        assert_eq!(
            client
                .post(&endpoint)
                .header("origin", ORIGIN)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for fields in [
        json!({"event":"arbitrary","sessionId":session}),
        json!({"event":"single_player_stop","sessionId":session,"reason":"private text"}),
        json!({"event":"single_player_start","sessionId":session,"at":1}),
        json!({"ipAddress":"198.51.100.3"}),
    ] {
        let mut body = json!({"visitorId":visitor});
        body.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        assert_eq!(
            client
                .post(&endpoint)
                .header("origin", ORIGIN)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let h = server.state.lock().await;
    for table in ["visitors", "visitor_networks", "single_player_events"] {
        assert_eq!(
            h.db.test_conn()
                .query_row(&format!("SELECT count(*) FROM {table}"), &[], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn lifecycle_has_a_separate_bounded_network_quota_from_heartbeats() {
    let server = Server::new().await;
    let client = reqwest::Client::new();
    let endpoint = format!("{}/api/visits", server.url);
    let visitor = uuid::Uuid::new_v4();
    let session = uuid::Uuid::new_v4();
    for _ in 0..60 {
        assert_eq!(
            client
                .post(&endpoint)
                .header("origin", ORIGIN)
                .json(&json!({"visitorId":visitor}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
    }
    assert_eq!(
        client
            .post(&endpoint)
            .header("origin", ORIGIN)
            .json(&json!({"visitorId":visitor}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    for i in 0..120 {
        let body = if i % 2 == 0 {
            json!({"visitorId":visitor,"sessionId":session,"event":"single_player_start"})
        } else {
            json!({"visitorId":visitor,"sessionId":session,"event":"single_player_stop","reason":"quit"})
        };
        assert_eq!(
            client
                .post(&endpoint)
                .header("origin", ORIGIN)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT,
            "event request {i}"
        );
    }
    assert_eq!(client.post(&endpoint).header("origin",ORIGIN).json(&json!({"visitorId":uuid::Uuid::new_v4(),"sessionId":uuid::Uuid::new_v4(),"event":"single_player_start"})).send().await.unwrap().status(),StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        server
            .state
            .lock()
            .await
            .db
            .test_conn()
            .query_row("SELECT count(*) FROM single_player_events", &[], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn trusted_proxy_mode_records_only_the_appended_canonical_viewer_ip() {
    let server = Server::new().await;
    server.state.lock().await.config.proxy = true;
    let client = reqwest::Client::new();
    let endpoint = format!("{}/api/visits", server.url);
    let visitor = uuid::Uuid::new_v4();
    for forwarded in [
        Some("198.51.100.4, 2001:0db8:0:0:0:0:0:1"),
        Some("198.51.100.4, invalid"),
        None,
    ] {
        let mut request=client.post(&endpoint).header("origin",ORIGIN).json(&json!({"visitorId":visitor,"sessionId":uuid::Uuid::new_v4(),"event":"single_player_start"}));
        if let Some(value) = forwarded {
            request = request.header("x-forwarded-for", value);
        }
        assert_eq!(
            request.send().await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
    }
    let h = server.state.lock().await;
    assert_eq!(
        h.db.test_conn()
            .query_row("SELECT ip_address FROM visitor_networks", &[], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "2001:db8::1"
    );
    assert_eq!(
        h.db.test_conn()
            .query_row(
                "SELECT count(*) FROM single_player_events WHERE ip_address IS NULL",
                &[],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
}
