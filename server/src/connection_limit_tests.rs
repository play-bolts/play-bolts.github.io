use super::*;
use crate::{hub::Config, limits::CONNECTIONS_PER_IP};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{self, client::IntoClientRequest},
};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct Server {
    state: Shared,
    url: String,
    task: tokio::task::JoinHandle<()>,
    _directory: tempfile::TempDir,
}
impl Server {
    async fn new(proxy: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(Mutex::new(
            Hub::new(Config {
                bind: "127.0.0.1:0".into(),
                database: directory.path().join("limits.sqlite"),
                origins: vec!["https://play-bolts.github.io".into()],
                identity_salt: "connection-limits-integration-test-salt".into(),
                empty_seconds: 300.0,
                reconnect_seconds: 30.0,
                max_rooms: 4,
                proxy,
            })
            .unwrap(),
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
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
    async fn connect(&self, path: &str, ip: &str) -> Result<Socket, tungstenite::Error> {
        let mut request = format!("{}{path}", self.url).into_client_request().unwrap();
        request
            .headers_mut()
            .insert("origin", "https://play-bolts.github.io".parse().unwrap());
        request
            .headers_mut()
            .insert("x-forwarded-for", ip.parse().unwrap());
        tokio_tungstenite::connect_async(request)
            .await
            .map(|(socket, _)| socket)
    }
    async fn token(&self) -> String {
        self.state.lock().await.db.session(None).unwrap().unwrap().1
    }
    async fn active(&self, ip: &str, wanted: usize) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if self.state.lock().await.connection_limits.active(ip) == wanted {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("IP {ip} did not settle at {wanted} connections"));
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn json_message(socket: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                tungstenite::Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                tungstenite::Message::Binary(data) => return rmp_serde::from_slice(&data).unwrap(),
                tungstenite::Message::Ping(_) => {
                    socket.flush().await.unwrap();
                }
                other => panic!("expected game message, received {other:?}"),
            }
        }
    })
    .await
    .unwrap()
}
async fn hello(socket: &mut Socket, token: &str) -> Value {
    socket
        .send(tungstenite::Message::Text(
            json!({"type":"hello","version":crate::codec::PROTOCOL_VERSION,"token":token})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    json_message(socket).await
}
async fn join(socket: &mut Socket, lobby: &str, spectator: bool) -> Value {
    socket.send(tungstenite::Message::Text(json!({"type":"join","lobbyId":lobby,"name":"Limit test","faction":"british","spectator":spectator}).to_string().into())).await.unwrap();
    json_message(socket).await
}
fn assert_limited(result: Result<Socket, tungstenite::Error>) {
    assert!(
        matches!(result, Err(tungstenite::Error::Http(response)) if response.status() == StatusCode::TOO_MANY_REQUESTS)
    );
}

#[tokio::test]
async fn probes_and_pending_hello_share_the_ip_limit_and_disconnect_releases_permits() {
    let server = Server::new(true).await;
    let ip = "192.0.2.51";
    let mut sockets = Vec::new();
    for index in 0..CONNECTIONS_PER_IP {
        sockets.push(
            server
                .connect(
                    if index % 2 == 0 {
                        "/api/ping"
                    } else {
                        "/api/ws"
                    },
                    ip,
                )
                .await
                .unwrap(),
        );
    }
    server.active(ip, CONNECTIONS_PER_IP).await;
    for path in ["/api/ws", "/api/ping"] {
        assert_limited(server.connect(path, "::ffff:192.0.2.51").await);
        assert_limited(server.connect(path, "203.0.113.88, 192.0.2.51").await);
    }
    let mut independent = server.connect("/api/ws", "192.0.2.52").await.unwrap();
    assert_eq!(
        hello(&mut independent, &server.token().await).await["type"],
        "welcome"
    );
    sockets.pop().unwrap().close(None).await.unwrap();
    server.active(ip, CONNECTIONS_PER_IP - 1).await;
    let replacement = server.connect("/api/ws", ip).await.unwrap();
    drop(replacement);
    drop(sockets);
    drop(independent);
    server.active(ip, 0).await;
    server.active("192.0.2.52", 0).await;
    assert!(!server.state.lock().await.failed);
}

#[tokio::test]
async fn failed_authentication_and_completed_probes_release_slots_for_the_next_player() {
    let server = Server::new(true).await;
    let ip = "2001:db8::52";
    let mut sockets = Vec::new();
    for _ in 0..CONNECTIONS_PER_IP - 1 {
        sockets.push(server.connect("/api/ws", ip).await.unwrap());
    }
    let mut invalid = server
        .connect("/api/ws", "2001:0db8:0:0:0:0:0:52")
        .await
        .unwrap();
    assert_eq!(
        hello(&mut invalid, "invalid-token").await["code"],
        "unauthenticated"
    );
    server.active(ip, CONNECTIONS_PER_IP - 1).await;
    let mut probe = server.connect("/api/ping", ip).await.unwrap();
    for nonce in ["one", "two", "three"] {
        probe
            .send(tungstenite::Message::Text(
                json!({"type":"ping","nonce":nonce}).to_string().into(),
            ))
            .await
            .unwrap();
        assert_eq!(
            json_message(&mut probe).await,
            json!({"type":"pong","nonce":nonce})
        );
    }
    server.active(ip, CONNECTIONS_PER_IP - 1).await;
    let mut valid = server.connect("/api/ws", ip).await.unwrap();
    assert_eq!(
        hello(&mut valid, &server.token().await).await["type"],
        "welcome"
    );
    assert_limited(server.connect("/api/ping", ip).await);
    drop(valid);
    drop(sockets);
    server.active(ip, 0).await;
}

#[tokio::test]
async fn direct_connections_ignore_spoofed_forwarding_headers() {
    let server = Server::new(false).await;
    let mut sockets = Vec::new();
    for index in 0..CONNECTIONS_PER_IP {
        sockets.push(
            server
                .connect("/api/ws", &format!("192.0.2.{index}"))
                .await
                .unwrap(),
        );
    }
    assert_limited(server.connect("/api/ws", "203.0.113.99").await);
    server.active("127.0.0.1", CONNECTIONS_PER_IP).await;
    drop(sockets);
    server.active("127.0.0.1", 0).await;
}

#[tokio::test]
async fn seat_limit_rejections_are_recoverable_and_ip_changes_do_not_replace_an_allowed_player() {
    let server = Server::new(true).await;
    let ip = "192.0.2.70";
    let lobby = server.state.lock().await.lobbies().unwrap()["lobbies"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut players = Vec::new();
    for index in 0..4 {
        let mut socket = server.connect("/api/ws", ip).await.unwrap();
        assert_eq!(
            hello(&mut socket, &server.token().await).await["type"],
            "welcome"
        );
        assert_eq!(
            join(&mut socket, &lobby, index % 2 == 0).await["type"],
            "joined"
        );
        players.push(socket);
    }
    let mut fifth = server.connect("/api/ws", ip).await.unwrap();
    assert_eq!(
        hello(&mut fifth, &server.token().await).await["type"],
        "welcome"
    );
    assert_eq!(
        join(&mut fifth, &lobby, false).await["code"],
        "ip_seat_limit"
    );
    let independent_token = server.token().await;
    let mut independent = server.connect("/api/ws", "192.0.2.71").await.unwrap();
    let welcome = hello(&mut independent, &independent_token).await;
    assert_eq!(
        join(&mut independent, &lobby, false).await["type"],
        "joined"
    );
    let prior_connection = server.state.lock().await.connections
        [welcome["playerId"].as_str().unwrap()]
    .cid
    .clone();
    let mut moved = server.connect("/api/ws", ip).await.unwrap();
    assert_eq!(
        hello(&mut moved, &independent_token).await["code"],
        "ip_seat_limit"
    );
    server.active(ip, 5).await;
    assert_eq!(
        server.state.lock().await.connections[welcome["playerId"].as_str().unwrap()].cid,
        prior_connection
    );
    assert_eq!(
        join(&mut independent, &lobby, false).await["type"],
        "joined"
    );
    players.pop().unwrap().close(None).await.unwrap();
    server.active(ip, 4).await;
    assert_eq!(
        join(&mut fifth, &lobby, true).await["code"],
        "ip_seat_limit",
        "disconnected players retain seats during grace"
    );
    players[0]
        .send(tungstenite::Message::Text(
            json!({"type":"leave"}).to_string().into(),
        ))
        .await
        .unwrap();
    assert_eq!(json_message(&mut players[0]).await["type"], "left");
    assert_eq!(join(&mut fifth, &lobby, true).await["type"], "joined");
    assert!(!server.state.lock().await.failed);
    drop(players);
    drop(fifth);
    drop(independent);
    drop(moved);
    server.active(ip, 0).await;
    server.active("192.0.2.71", 0).await;
}

#[tokio::test]
async fn invalid_upgrade_headers_do_not_consume_an_ip_slot() {
    let server = Server::new(true).await;
    let response = reqwest::Client::new()
        .get(format!("{}/api/ws", server.url.replacen("ws:", "http:", 1)))
        .header("x-forwarded-for", "192.0.2.72")
        .header("origin", "https://play-bolts.github.io")
        .send()
        .await
        .unwrap();
    assert!(response.status().is_client_error());
    server.active("192.0.2.72", 0).await;
    let mut request = format!("{}/api/ws", server.url)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("x-forwarded-for", "192.0.2.72".parse().unwrap());
    request
        .headers_mut()
        .insert("origin", "https://invalid.example".parse().unwrap());
    assert!(
        matches!(tokio_tungstenite::connect_async(request).await, Err(tungstenite::Error::Http(response)) if response.status() == StatusCode::FORBIDDEN)
    );
    server.active("192.0.2.72", 0).await;
    let socket = server.connect("/api/ws", "192.0.2.72").await.unwrap();
    drop(socket);
    server.active("192.0.2.72", 0).await;
}

#[tokio::test]
async fn ping_and_pong_floods_obey_the_same_message_quota_as_game_inputs() {
    for ping in [false, true] {
        let server = Server::new(true).await;
        let ip = if ping { "192.0.2.61" } else { "192.0.2.62" };
        let mut socket = server.connect("/api/ws", ip).await.unwrap();
        assert_eq!(
            hello(&mut socket, &server.token().await).await["type"],
            "welcome"
        );
        for _ in 0..151 {
            let payload = vec![1].into();
            if socket
                .feed(if ping {
                    tungstenite::Message::Ping(payload)
                } else {
                    tungstenite::Message::Pong(payload)
                })
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = socket.flush().await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() {
                    break;
                }
            }
        })
        .await
        .expect("control-frame flood must close the socket");
        server.active(ip, 0).await;
        assert!(server.state.lock().await.connections.is_empty());
        let mut next = server.connect("/api/ws", ip).await.unwrap();
        assert_eq!(
            hello(&mut next, &server.token().await).await["type"],
            "welcome"
        );
        drop(next);
        server.active(ip, 0).await;
    }
}
