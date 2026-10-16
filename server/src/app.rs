use crate::{
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
use futures_util::SinkExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore, mpsc, watch};
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
            "/api/feedback",
            post(feedback).layer(DefaultBodyLimit::max(12_288)),
        )
        .route("/api/ws", get(upgrade))
        .layer(DefaultBodyLimit::max(4096))
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers([axum::http::header::CONTENT_TYPE]),
        )
        .with_state(state)
}
async fn health(State(state): State<Shared>) -> Response {
    if state.lock().await.failed {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"ok":false,"version":1})),
        )
            .into_response()
    } else {
        Json(json!({"ok":true,"version":1})).into_response()
    }
}
fn peer(h: &Hub, address: SocketAddr, headers: &HeaderMap) -> String {
    if h.config.proxy {
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
    }
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
    if h.failed {
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
    match h.db.session(body.token.as_deref()) {
        Ok(Some((player, token))) => Json(json!({"playerId":player,"token":token})).into_response(),
        Ok(None) => (
            StatusCode::UNAUTHORIZED,
            Json(error("unauthenticated", "Session expired.")),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error=%e,"identity persistence failed");
            h.fail();
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
    if h.failed {
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
    if h.failed {
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
    match h.db.leaderboard(crate::db::now_ms()) {
        Ok(board) => Json(board).into_response(),
        Err(e) => {
            tracing::error!(error=%e,"leaderboard persistence failed");
            h.fail();
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
    match h.db.feedback(&message, email.as_deref(), &ip_hash) {
        Ok(Some(id)) => (StatusCode::CREATED, Json(json!({"id":id}))).into_response(),
        Ok(None) => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(error("rate_limited", "Try again later.")),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error=%e,"feedback persistence failed");
            h.fail();
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
    if h.failed {
        return unavailable();
    }
    if !h.allowed_origin(origin(&headers)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let ip = peer(&h, address, &headers);
    if h.connections.len() >= 256 || !h.allow(format!("upgrade:{ip}"), 60, 60) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
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
            serve_socket(socket, state, ip, ua).await;
        })
}

#[cfg(test)]
#[path = "community_api_tests.rs"]
mod community_tests;
async fn serve_socket(mut socket: WebSocket, state: Shared, ip: String, ua: String) {
    let initial = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let hello = match initial {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Value>(&text).ok(),
        _ => None,
    };
    let Some(hello) = hello else {
        return;
    };
    if hello["type"] != "hello" || hello["version"] != 1 {
        let _ = socket
            .send(Message::Text(
                error("unauthenticated", "Protocol mismatch.")
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }
    let Some(token) = hello["token"].as_str() else {
        return;
    };
    let player = match state.lock().await.db.authenticate(token) {
        Ok(Some(p)) => p,
        _ => {
            let _ = socket
                .send(Message::Text(
                    error("unauthenticated", "Session expired.")
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    };
    let cid = crate::db::id();
    let (tx, mut rx) = mpsc::channel::<String>(64);
    let (cancel, mut cancelled) = watch::channel::<Option<String>>(None);
    {
        let mut h = state.lock().await;
        if let Err(e) = h.register(&player, cid.clone(), tx, cancel, &ip, &ua) {
            tracing::error!(error=%e,"connection persistence failed");
            h.fail();
            return;
        }
        h.send(&player, json!({"type":"welcome","playerId":player}));
    }
    let idle = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(idle);
    let mut ping = tokio::time::interval(Duration::from_secs(3));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
         _ = cancelled.changed() => { let reason=cancelled.borrow().clone().unwrap_or_else(||"server_stop".into()); let _=socket.send(Message::Text(error(&reason,if reason=="session_replaced"{"Connected in another tab."}else{"Connection closed."}).to_string().into())).await; let _=socket.send(Message::Close(Some(axum::extract::ws::CloseFrame{code:if reason=="session_replaced"{4001}else{4002},reason:reason.into()}))).await; break; },
         _=&mut idle=>break,
         _=ping.tick()=>{
          let nonce=state.lock().await.ping(&player,&cid,Instant::now());
          if let Some(nonce)=nonce
           && !matches!(tokio::time::timeout(Duration::from_secs(3),socket.send(Message::Ping(nonce.into()))).await,Ok(Ok(()))){break;}
         },
         outgoing=rx.recv()=>{let Some(text)=outgoing else{break;};if !matches!(tokio::time::timeout(Duration::from_secs(3),socket.send(Message::Text(text.into()))).await,Ok(Ok(()))){break;}},
         incoming=socket.recv()=>{
          idle.as_mut().reset(tokio::time::Instant::now()+Duration::from_secs(30));
          let text=match incoming {Some(Ok(Message::Text(text)))=>text,Some(Ok(Message::Ping(v)))=>{let _=socket.send(Message::Pong(v)).await;continue;},Some(Ok(Message::Pong(v)))=>{state.lock().await.pong(&player,&cid,&v,Instant::now());continue;},_=>break};
          let mut h=state.lock().await;if h.failed||!h.connections.get(&player).is_some_and(|e|e.cid==cid){break;}
          if !h.allow(format!("ws:{cid}"),150,1){h.send(&player,error("rate_limited","Too many messages."));break;}
          let value=match serde_json::from_str::<Value>(&text){Ok(v)=>v,Err(_)=>{h.send(&player,error("invalid_message","Invalid message."));continue;}};
          let result:crate::hub::HResult<()>=match value["type"].as_str(){
           Some("join")=>{if h.allow(format!("join:{player}"),10,10){let faction=serde_json::from_value::<Faction>(value["faction"].clone());let spectator=serde_json::from_value::<bool>(value.get("spectator").cloned().unwrap_or(json!(false)));match (faction,spectator){(Ok(faction),Ok(spectator))=>h.join(&player,&cid,value["lobbyId"].as_str(),value["name"].as_str().unwrap_or(DEFAULT_PLAYER_NAME),faction,spectator),_=>Err("invalid_message".into())}}else{Err("rate_limited".into())}},
           Some("input")=>match serde_json::from_value::<InputFrame>(value){Ok(input)=>{h.input(&player,input);Ok(())},Err(_)=>Err("invalid_message".into())},
           Some("chat")=>h.chat(&player,&cid,value["text"].as_str().unwrap_or("")),
           Some("profile")=>if h.allow(format!("profile:{player}"),6,10){h.profile(&player,value["name"].as_str().unwrap_or(DEFAULT_PLAYER_NAME))}else{Err("rate_limited".into())},
           Some("loadout")=>if h.allow(format!("loadout:{player}"),3,10){match serde_json::from_value::<Faction>(value["faction"].clone()){Ok(f)=>h.loadout(&player,f),Err(_)=>Err("invalid_message".into())}}else{Err("rate_limited".into())},
           Some("spectate")=>if h.allow(format!("loadout:{player}"),3,10){h.spectate(&player)}else{Err("rate_limited".into())},
           Some("leave")=>h.leave(&player,"left",true),
           Some("ping")=>{h.send(&player,json!({"type":"pong","nonce":value["nonce"]}));Ok(())},
           _=>Err("invalid_message".into())
          };
          if let Err(e)=result{let code=e.to_string();let message=match code.as_str(){"lobby_full"=>"Lobby full.","lobby_missing"=>"Lobby closed.","not_joined"=>"Join a lobby first.","rate_limited"=>"Try again shortly.","server_busy"=>"Server full.","invalid_message"=>"Invalid message.",_=>{tracing::error!(error=%e,"persistent game operation failed");h.fail();break;}};h.send(&player,error(&code,message));}
         }
        }
    }
    let _ = socket.close().await;
    let mut h = state.lock().await;
    if let Err(e) = h.disconnected(&player, &cid) {
        tracing::error!(error=%e,"disconnect persistence failed");
        h.fail();
    }
}
