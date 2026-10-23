use crate::{
    db::visitors::VisitRequest,
    hub::{Hub, error},
    sim::{DEFAULT_PLAYER_NAME, Faction, InputFrame},
};
use axum::{
    Json, Router,
    extract::{
        ConnectInfo, DefaultBodyLimit, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore, watch};
use tower_http::cors::CorsLayer;
pub type Shared = Arc<Mutex<Hub>>;
// Count upgrades waiting for hello as well as authenticated sockets. A guard
// releases the slot on every reject/disconnect path, including failed upgrades.
static CONNECTION_SLOTS: Semaphore = Semaphore::const_new(256);
pub fn router(state: Shared) -> Router {
    let origins = state
        .try_lock()
        .expect("initial state")
        .config
        .origins
        .iter()
        .filter_map(|s| s.parse::<HeaderValue>().ok())
        .collect::<Vec<_>>();
    Router::new()
        .route("/api/health", get(health))
        .route("/api/session", post(session))
        .route("/api/lobbies", get(lobbies))
        .route("/api/status", get(status))
        .route("/api/leaderboard", get(leaderboard))
        .route(
            "/api/visits",
            post(visit).layer(DefaultBodyLimit::max(256)),
        )
        .route(
            "/api/feedback",
            post(feedback).layer(DefaultBodyLimit::max(12_288)),
        )
        .route("/api/ws", get(upgrade))
        .route("/api/ping", get(probe))
        .route(
            "/internal/cluster",
            post(crate::cluster::handle).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .layer(DefaultBodyLimit::max(4096))
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers([axum::http::header::CONTENT_TYPE]),
        )
        .with_state(state.clone())
        .merge(crate::admin::router(state))
}
async fn health(State(state): State<Shared>) -> Response {
    let h = state.lock().await;
    if h.failed || h.shutting_down {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"ok":false,"version":crate::codec::PROTOCOL_VERSION})),
        )
            .into_response()
    } else {
        Json(json!({"ok":true,"version":crate::codec::PROTOCOL_VERSION})).into_response()
    }
}
fn peer(h: &Hub, address: SocketAddr, headers: &HeaderMap) -> String {
    let value = if h.config.proxy {
        headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next_back())
            .map(str::trim)
            .filter(|s| s.parse::<std::net::IpAddr>().is_ok())
            .unwrap_or("unknown")
            .to_owned()
    } else {
        address.ip().to_string()
    };
    crate::limits::canonical_ip(&value)
}
fn origin(headers: &HeaderMap) -> Option<&str> {
    headers.get("origin").and_then(|s| s.to_str().ok())
}
fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(error("server_busy", "Server unavailable.")),
    )
        .into_response()
}
#[derive(Deserialize)]
struct SessionRequest {
    token: Option<String>,
}
async fn session(
    State(state): State<Shared>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<SessionRequest>,
) -> Response {
    let mut h = state.lock().await;
    if h.failed || h.shutting_down {
        return unavailable();
    }
    if !h.allowed_origin(origin(&headers)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let key = format!("session:{}", peer(&h, address, &headers));
    if !h.allow(key, 30, 60) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(error("rate_limited", "Try again shortly.")),
        )
            .into_response();
    }
    let storage = h.db.clone();
    drop(h);
    match storage.request(move |db| Ok(db.session(body.token.as_deref())?)).await {
        Ok(Some((player, token))) => Json(json!({"playerId":player,"token":token})).into_response(),
        Ok(None) => (
            StatusCode::UNAUTHORIZED,
            Json(error("unauthenticated", "Session expired.")),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error=%e,"identity persistence failed");
            unavailable()
        }
    }
}
async fn lobbies(
    State(state): State<Shared>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let mut h = state.lock().await;
    if h.failed || h.shutting_down {
        return unavailable();
    }
    if !h.allowed_origin(origin(&headers)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let key = format!("list:{}", peer(&h, address, &headers));
    if !h.allow(key, 120, 60) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    match h.lobbies() {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            tracing::error!(error=%e,"lobby persistence failed");
            h.fail();
            unavailable()
        }
    }
}
fn community_access(
    h: &mut Hub,
    address: SocketAddr,
    headers: &HeaderMap,
    route: &str,
    limit: usize,
) -> Option<Response> {
    if h.failed || h.shutting_down {
        return Some(unavailable());
    }
    if !h.allowed_origin(origin(headers)) {
        return Some(StatusCode::FORBIDDEN.into_response());
    }
    let key = format!("{route}:{}", peer(h, address, headers));
    if !h.allow(key, limit, 60) {
        return Some(
            (
                StatusCode::TOO_MANY_REQUESTS,
                Json(error("rate_limited", "Try again shortly.")),
            )
                .into_response(),
        );
    }
    None
}
async fn status(
    State(state): State<Shared>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let mut h = state.lock().await;
    if let Some(response) = community_access(&mut h, address, &headers, "status", 120) {
        return response;
    }
    Json(json!({"online":h.online_count()})).into_response()
}
async fn leaderboard(
    State(state): State<Shared>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let mut h = state.lock().await;
    if let Some(response) = community_access(&mut h, address, &headers, "leaderboard", 30) {
        return response;
    }
    let storage = h.db.clone();
    drop(h);
    match storage.request(|db| Ok(db.leaderboard(crate::db::now_ms())?)).await {
        Ok(board) => Json(board).into_response(),
        Err(e) => {
            tracing::error!(error=%e,"leaderboard persistence failed");
            unavailable()
        }
    }
}

async fn visit(
    State(state): State<Shared>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<VisitRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let mut h = state.lock().await;
    // Unlike read-only public endpoints, a visit requires one exact allowlisted
    // browser Origin; reject absent and ambiguous origins as well. This is not
    // authentication: non-browser clients can still forge an allowed Origin.
    if headers.get_all("origin").iter().count() != 1
        || origin(&headers).is_none()
        || !h.allowed_origin(origin(&headers))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Lifecycle bursts must not compete with minute heartbeats. Both remain
    // bounded per observed network, independently of random visitor IDs.
    let (route, limit) = if body.as_ref().is_ok_and(|Json(body)| body.is_event()) {
        ("visit_events", 120)
    } else {
        ("visits", 60)
    };
    if let Some(response) = community_access(&mut h, address, &headers, route, limit) {
        return response;
    }
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    let Some((visitor_id, event)) = body.validate() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let ip = peer(&h, address, &headers).parse().ok();
    let storage = h.db.clone();
    drop(h);
    match storage
        .request(move |db| {
            Ok(db.record_visitor_activity(&visitor_id, ip, event.as_ref(), crate::db::now_ms())?)
        })
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            // Analytics are optional: a failed heartbeat must never end games.
            tracing::warn!(error=%e,"visitor persistence failed");
            unavailable()
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeedbackRequest {
    message: String,
    email: Option<String>,
}
fn feedback_fields(body: FeedbackRequest) -> Result<(String, Option<String>), &'static str> {
    let message = body.message.trim().to_owned();
    if message.is_empty()
        || message.chars().count() > 2000
        || message
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err("Enter feedback between 1 and 2000 characters.");
    }
    let email = body
        .email
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if let Some(email) = &email {
        let valid = email.len() <= 254
            && email.is_ascii()
            && !email.chars().any(|c| c.is_whitespace() || c.is_control())
            && email.split_once('@').is_some_and(|(local, domain)| {
                !local.is_empty()
                    && local.len() <= 64
                    && !local.starts_with('.')
                    && !local.ends_with('.')
                    && !local.contains("..")
                    && local
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b".!#$%&'*+-/=?^_`{|}~".contains(&c))
                    && domain.contains('.')
                    && domain.split('.').all(|label| {
                        !label.is_empty()
                            && label.len() <= 63
                            && !label.starts_with('-')
                            && !label.ends_with('-')
                            && label
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    })
            });
        if !valid {
            return Err("Enter a valid email address or leave it blank.");
        }
    }
    Ok((message, email))
}
async fn feedback(
    State(state): State<Shared>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<FeedbackRequest>,
) -> Response {
    let mut h = state.lock().await;
    if let Some(response) = community_access(&mut h, address, &headers, "feedback", 3) {
        return response;
    }
    let (message, email) = match feedback_fields(body) {
        Ok(fields) => fields,
        Err(message) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(error("invalid_message", message)),
            )
                .into_response();
        }
    };
    let ip_hash = h.fingerprint(&format!("feedback:{}", peer(&h, address, &headers)));
    let storage = h.db.clone();
    drop(h);
    match storage.request(move |db| Ok(db.feedback(&message, email.as_deref(), &ip_hash)?)).await {
        Ok(Some(id)) => (StatusCode::CREATED, Json(json!({"id":id}))).into_response(),
        Ok(None) => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(error("rate_limited", "Try again later.")),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error=%e,"feedback persistence failed");
            unavailable()
        }
    }
}
async fn upgrade(
    State(state): State<Shared>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Ok(slot) = CONNECTION_SLOTS.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let mut h = state.lock().await;
    if h.failed || h.shutting_down {
        return unavailable();
    }
    if !h.allowed_origin(origin(&headers)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let ip = peer(&h, address, &headers);
    if h.connections.len() >= 256 || !h.allow(format!("upgrade:{ip}"), 60, 60) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let Some(ip_slot) = h.connection_limits.acquire(&ip) else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let ua = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(512)
        .collect::<String>();
    drop(h);
    ws.max_message_size(8192)
        .max_frame_size(8192)
        .on_upgrade(move |socket| async move {
            let _slot = slot;
            let _ip_slot = ip_slot;
            serve_socket(socket, state, ip, ua).await;
        })
}

// A probe reserves no account or lobby seat and never creates a game.
async fn probe(
    State(state): State<Shared>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Ok(slot) = CONNECTION_SLOTS.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let mut h = state.lock().await;
    if h.failed || h.shutting_down { return unavailable(); }
    let ip = peer(&h, address, &headers);
    let key = format!("probe:{ip}");
    if !h.allowed_origin(origin(&headers)) || !h.allow(key, 60, 60) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(ip_slot) = h.connection_limits.acquire(&ip) else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    drop(h);
    ws.max_message_size(256)
        .max_frame_size(256)
        .on_upgrade(move |mut socket| async move {
            let _slot = slot;
            let _ip_slot = ip_slot;
            let _ = tokio::time::timeout(Duration::from_secs(4), async {
                for _ in 0..3 {
                    let Some(Ok(Message::Text(text))) = socket.recv().await else {
                        break;
                    };
                    let Ok(value) = serde_json::from_str::<Value>(&text) else {
                        break;
                    };
                    if value["type"] != "ping" || !value["nonce"].is_string() {
                        break;
                    }
                    if socket
                        .send(Message::Text(
                            json!({"type":"pong","nonce":value["nonce"]})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .await;
            let _ = socket.close().await;
        })
}

#[cfg(test)]
#[path = "community_api_tests.rs"]
mod community_tests;
#[cfg(test)]
#[path = "visitor_api_tests.rs"]
mod visitor_tests;
#[cfg(test)]
#[path = "connection_limit_tests.rs"]
mod connection_limit_tests;

/// Decode bounded control messages once, before taking the shared simulation
/// lock. High-rate inputs have a separate compact binary representation.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum ClientControl {
    Join {
        #[serde(rename = "lobbyId")]
        lobby_id: Option<String>,
        name: Option<String>,
        faction: Faction,
        #[serde(default)]
        spectator: bool,
    },
    Chat { text: String },
    Profile { name: String },
    Loadout { faction: Faction },
    Spectate {},
    Leave {},
    Ping { nonce: PingNonce },
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(untagged)]
enum PingNonce {
    Number(f64),
    Text(String),
}

enum ClientMessage {
    Control(ClientControl),
    Input(InputFrame),
}

fn decode_client_message(message: Message) -> Result<ClientMessage, ()> {
    match message {
        Message::Binary(bytes) => crate::codec::decode_input(&bytes)
            .map(ClientMessage::Input)
            .map_err(|_| ()),
        Message::Text(text) => {
            if text.len() > 8192 { return Err(()); }
            let control: ClientControl = serde_json::from_str(&text).map_err(|_| ())?;
            if let ClientControl::Ping { nonce } = &control {
                match nonce {
                    PingNonce::Number(value) if !value.is_finite() => return Err(()),
                    PingNonce::Text(value) if value.len() > 64 => return Err(()),
                    _ => {},
                }
            }
            Ok(ClientMessage::Control(control))
        },
        _ => Err(()),
    }
}

#[cfg(test)]
mod control_decode_tests {
    use super::*;

    fn decode(value: Value) -> Result<ClientMessage, ()> {
        decode_client_message(Message::Text(value.to_string().into()))
    }

    #[test]
    fn typed_controls_preserve_optional_join_defaults_and_color_names() {
        let message = decode(json!({"type":"join","name":"^3Ålex","faction":"russian"})).unwrap();
        assert!(matches!(message, ClientMessage::Control(ClientControl::Join {
            lobby_id: None, name: Some(name), faction: Faction::Russian, spectator: false
        }) if name == "^3Ålex"));
        assert!(matches!(decode(json!({"type":"spectate"})), Ok(ClientMessage::Control(ClientControl::Spectate {}))));
    }

    #[test]
    fn rejects_old_json_inputs_unknown_fields_and_non_scalar_ping_nonces() {
        for value in [
            json!({"type":"input","seq":1,"tick":10,"generation":1}),
            json!({"type":"join","faction":"german","spectator":"false"}),
            json!({"type":"loadout","faction":"other"}),
            json!({"type":"leave","health":100}),
            json!({"type":"ping","nonce":{"large":"object"}}),
            json!({"type":"ping","nonce":"x".repeat(65)}),
            json!({"type":"chat","text":"x".repeat(8192)}),
        ] {
            assert!(decode(value.clone()).is_err(), "accepted malformed control: {value}");
        }
        assert!(decode(json!({"type":"ping","nonce":123.25})).is_ok());
        assert!(decode(json!({"type":"ping","nonce":"bounded-probe"})).is_ok());
    }
}

async fn serve_socket(mut socket: WebSocket, state: Shared, ip: String, ua: String) {
    let initial = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let hello = match initial {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Value>(&text).ok(),
        _ => None,
    };
    let Some(hello) = hello else {
        return;
    };
    if hello["type"] != "hello" || hello["version"] != crate::codec::PROTOCOL_VERSION {
        let _ = socket
            .send(Message::Text(
                error("protocol_mismatch", "Reload Bolts to update.")
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }
    let Some(token) = hello["token"].as_str() else {
        return;
    };
    let storage = state.lock().await.db.clone();
    let token = token.to_owned();
    let player = match storage.request(move |db| Ok(db.authenticate(&token)?)).await {
        Ok(Some(p)) => p,
        result => {
            let message = match result {
                Ok(None) => error("unauthenticated", "Session expired."),
                Err(error) => {
                    tracing::warn!(%error, "authentication storage unavailable");
                    // A transient queue/disk failure must not erase the browser's
                    // persistent player credential as an expired token would.
                    crate::hub::error("server_busy", "Server unavailable.")
                }
                Ok(Some(_)) => unreachable!(),
            };
            let _ = socket.send(Message::Text(message.to_string().into())).await;
            return;
        }
    };
    let cid = crate::db::id();
    let (tx, outgoing) = crate::transport::channel();
    let (cancel, mut cancelled) = watch::channel::<Option<String>>(None);
    {
        let mut h = state.lock().await;
        if h.failed || h.shutting_down { return; }
        if let Err(e) = h.register(&player, cid.clone(), tx.clone(), cancel.clone(), &ip, &ua) {
            if e.to_string() == "ip_seat_limit" {
                drop(h);
                let _ = socket.send(Message::Text(error("ip_seat_limit", "This network already has four players or reserved seats.").to_string().into())).await;
                return;
            }
            tracing::error!(error=%e,"connection persistence failed");
            h.fail();
            return;
        }
        h.send(&player, json!({"type":"welcome","version":crate::codec::PROTOCOL_VERSION,"playerId":player}));
    }
    let (sink, mut incoming) = socket.split();
    let mut writer = tokio::spawn(crate::transport::write_socket(sink, outgoing, cancelled.clone()));
    let idle = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(idle);
    let mut ping = tokio::time::interval(Duration::from_secs(3));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut received_times = VecDeque::new();
    loop {
        tokio::select! {
         _ = cancelled.changed() => break,
         _ = &mut writer => break,
         _=&mut idle=>break,
         _=ping.tick()=>{
          let nonce=state.lock().await.ping(&player,&cid,Instant::now());
          if let Some(nonce)=nonce
           && !tx.control(Message::Ping(nonce.into())) { break; }
         },
         received=incoming.next()=>{
          idle.as_mut().reset(tokio::time::Instant::now()+Duration::from_secs(30));
          let Some(Ok(frame))=received else {break;};
          // Control frames consume the same budget as inputs and JSON. Count
          // before replying, so Ping/Pong floods cannot bypass the quota.
          let now=Instant::now();while received_times.front().is_some_and(|at|now.duration_since(*at)>=Duration::from_secs(1)){received_times.pop_front();}
          if received_times.len()>=150 {let _=tx.send(error("rate_limited","Too many messages."));break;}
          received_times.push_back(now);
          let frame=match frame {frame @ (Message::Text(_) | Message::Binary(_))=>frame,Message::Ping(v)=>{if !tx.control(Message::Pong(v)){break;}continue;},Message::Pong(v)=>{state.lock().await.pong(&player,&cid,&v,now);continue;},_=>break};
          let decoded=decode_client_message(frame);
          let mut h=state.lock().await;if h.failed||h.shutting_down||!h.connections.get(&player).is_some_and(|e|e.cid==cid){break;}
          let message=match decoded {Ok(message)=>message,Err(())=>{h.send(&player,error("invalid_message","Invalid message."));continue;}};
          let result:crate::hub::HResult<()>=match message {
           ClientMessage::Input(input)=>{h.input(&player,input);Ok(())},
           ClientMessage::Control(ClientControl::Join{lobby_id,name,faction,spectator})=>if h.allow(format!("join:{player}"),10,10){h.join(&player,&cid,lobby_id.as_deref(),name.as_deref().unwrap_or(DEFAULT_PLAYER_NAME),faction,spectator)}else{Err("rate_limited".into())},
           ClientMessage::Control(ClientControl::Chat{text})=>h.chat(&player,&cid,&text),
           ClientMessage::Control(ClientControl::Profile{name})=>if h.allow(format!("profile:{player}"),6,10){h.profile(&player,&name)}else{Err("rate_limited".into())},
           ClientMessage::Control(ClientControl::Loadout{faction})=>if h.allow(format!("loadout:{player}"),3,10){h.loadout(&player,faction)}else{Err("rate_limited".into())},
           ClientMessage::Control(ClientControl::Spectate{})=>if h.allow(format!("loadout:{player}"),3,10){h.spectate(&player)}else{Err("rate_limited".into())},
           ClientMessage::Control(ClientControl::Leave{})=>h.leave(&player,"left",true),
           ClientMessage::Control(ClientControl::Ping{nonce})=>{h.send(&player,json!({"type":"pong","nonce":nonce}));Ok(())},
          };
          if let Err(e)=result{let code=e.to_string();let message=match code.as_str(){"lobby_full"=>"Lobby full.","lobby_missing"=>"Lobby closed.","not_joined"=>"Join a lobby first.","rate_limited"=>"Try again shortly.","ip_seat_limit"=>"This network already has four players or reserved seats.","server_busy"=>"Server full.","invalid_message"=>"Invalid message.",_=>{tracing::error!(error=%e,"persistent game operation failed");h.fail();break;}};h.send(&player,error(&code,message));}
         }
        }
    }
    if cancel.borrow().is_none() { let _ = cancel.send(Some("connection_closed".into())); }
    if !writer.is_finished() {
        if tokio::time::timeout(Duration::from_millis(300), &mut writer).await.is_err() { writer.abort(); }
    }
    let mut h = state.lock().await;
    if let Err(e) = h.disconnected(&player, &cid) {
        tracing::error!(error=%e,"disconnect persistence failed");
        h.fail();
    }
}
