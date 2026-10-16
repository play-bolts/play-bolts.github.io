use super::*;
use crate::{hub::Config, sim::Faction};

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
                database: directory.path().join("api.sqlite"),
                origins: vec!["https://play-bolts.github.io".into()],
                identity_salt: "community-test-salt-with-at-least-32-chars".into(),
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

#[test]
fn feedback_validates_required_text_and_optional_email() {
    let valid = feedback_fields(FeedbackRequest {
        message: "  Useful feedback\nSecond line  ".into(),
        email: Some("  user+bolts@example.org  ".into()),
    })
    .unwrap();
    assert_eq!(
        valid,
        (
            "Useful feedback\nSecond line".into(),
            Some("user+bolts@example.org".into())
        )
    );
    for message in [
        "".to_owned(),
        " \n\t ".to_owned(),
        "x".repeat(2001),
        "null\0byte".to_owned(),
    ] {
        assert!(
            feedback_fields(FeedbackRequest {
                message,
                email: None
            })
            .is_err()
        );
    }
    for email in [
        "bad",
        "a@b",
        "a@@b.org",
        "a b@c.org",
        "a@-b.org",
        "a@b..org",
        ".a@b.org",
        "a\r\nb@c.org",
    ] {
        assert!(
            feedback_fields(FeedbackRequest {
                message: "valid".into(),
                email: Some(email.into())
            })
            .is_err(),
            "{email}"
        );
    }
    assert!(
        feedback_fields(FeedbackRequest {
            message: "世".repeat(2000),
            email: Some(" ".into())
        })
        .unwrap()
        .1
        .is_none()
    );
}

#[tokio::test]
async fn public_endpoints_check_origin_feedback_privacy_and_limits() {
    let server = Server::new().await;
    let client = reqwest::Client::new();
    for path in ["status", "leaderboard"] {
        let response = client
            .get(format!("{}/api/{path}", server.url))
            .header("origin", "https://evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let denied = client
        .post(format!("{}/api/feedback", server.url))
        .header("origin", "https://evil.example")
        .json(&json!({"message":"should not persist"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let response = client
        .get(format!("{}/api/status", server.url))
        .header("origin", "https://play-bolts.github.io")
        .send()
        .await
        .unwrap();
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "https://play-bolts.github.io"
    );
    assert_eq!(response.json::<Value>().await.unwrap(), json!({"online":0}));
    for i in 0..3 {
        let response=client.post(format!("{}/api/feedback",server.url)).header("origin","https://play-bolts.github.io").json(&json!({"message":if i==0 {"世".repeat(2000)} else {"Please improve this.".into()},"email":"test@example.org"})).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let result = response.json::<Value>().await.unwrap();
        assert!(uuid::Uuid::parse_str(result["id"].as_str().unwrap()).is_ok());
        assert_eq!(
            result.as_object().unwrap().len(),
            1,
            "no email or IP is echoed"
        );
    }
    let limited = client
        .post(format!("{}/api/feedback", server.url))
        .json(&json!({"message":"too soon"}))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    let no_read = client
        .get(format!("{}/api/feedback", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(no_read.status(), StatusCode::METHOD_NOT_ALLOWED);
    let board = client
        .get(format!("{}/api/leaderboard", server.url))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(board, json!({"allTime":[],"last24Hours":[]}));
    let h = server.state.lock().await;
    assert_eq!(
        h.db.test_conn()
            .query_row("SELECT count(*) FROM feedback_requests", &[], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        3
    );
    let hash: String =
        h.db.test_conn()
            .query_row("SELECT ip_hash FROM feedback_requests LIMIT 1", &[], |r| {
                r.get(0)
            })
            .unwrap();
    assert_eq!(hash.len(), 64);
    assert!(!hash.contains("127.0.0.1"));
}

#[tokio::test]
async fn api_counts_connected_humans_not_bot_fill_or_disconnected_seats() {
    let server = Server::new().await;
    let (player, cid, _rx, _cancel) = {
        let mut h = server.state.lock().await;
        let (player, _) = h.db.session(None).unwrap().unwrap();
        let cid = crate::db::id();
        let (tx, rx) = crate::transport::channel();
        let (cancel, receiver) = watch::channel(None);
        h.register(&player, cid.clone(), tx, cancel, "127.0.0.1", "test")
            .unwrap();
        assert_eq!(
            h.online_count(),
            0,
            "authenticated idle sockets do not count"
        );
        h.join(&player, &cid, None, "API Tester", Faction::British, false)
            .unwrap();
        (player, cid, rx, receiver)
    };
    let client = reqwest::Client::new();
    let count = client
        .get(format!("{}/api/status", server.url))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(count, json!({"online":1}));
    {
        let mut h = server.state.lock().await;
        h.loadout(&player, Faction::German).unwrap();
        let board = h.db.leaderboard(crate::db::now_ms()).unwrap();
        let score = board
            .all_time
            .iter()
            .find(|r| r.name == "API Tester")
            .unwrap();
        assert_eq!(
            (score.kills, score.deaths),
            (0, 1),
            "faction-change self-kill records one death and awards no kill"
        );
        h.loadout(&player, Faction::German).unwrap();
        let board = h.db.leaderboard(crate::db::now_ms()).unwrap();
        assert_eq!(
            board
                .all_time
                .iter()
                .find(|r| r.name == "API Tester")
                .unwrap()
                .deaths,
            1,
            "repeated unchanged loadout creates no second death"
        );
    }
    server
        .state
        .lock()
        .await
        .disconnected(&player, &cid)
        .unwrap();
    let count = client
        .get(format!("{}/api/status", server.url))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(count, json!({"online":0}));
}

#[tokio::test]
async fn invalid_feedback_is_rejected_without_persistence() {
    let server = Server::new().await;
    let client = reqwest::Client::new();
    for body in [
        json!({"message":"   "}),
        json!({"message":"good","email":"invalid"}),
    ] {
        let response = client
            .post(format!("{}/api/feedback", server.url))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response.json::<Value>().await.unwrap()["code"],
            "invalid_message"
        );
    }
    let response = client
        .post(format!("{}/api/feedback", server.url))
        .json(&json!({"message":"x".repeat(13_000)}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        server
            .state
            .lock()
            .await
            .db
            .test_conn()
            .query_row("SELECT count(*) FROM feedback_requests", &[], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
