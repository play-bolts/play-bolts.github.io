//! Key-authenticated operator reads. Each query has its own read-only SQLite
//! connection and blocking worker; it never runs on the game's storage writer.
use crate::{app::Shared, db, hub::error};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use rusqlite::{
    Connection, OpenFlags,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    types::{Value as SqlValue, ValueRef},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const KEY_CONTEXT: &[u8] = b"Bolts private admin API key verification";
const QUERY_MS: u64 = 250;
const MAX_BYTES: usize = 256 * 1024;
#[derive(Clone)]
struct AdminState {
    hub: Shared,
    key_tag: Option<[u8; 32]>,
    database: PathBuf,
    slots: Arc<Semaphore>,
}
fn key_mac(key: &str) -> Hmac<Sha256> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts any key length");
    mac.update(KEY_CONTEXT);
    mac
}
fn key_tag(key: Option<&str>) -> Option<[u8; 32]> {
    key.filter(|s| (32..=128).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_graphic()))
        .map(|s| key_mac(s).finalize().into_bytes().into())
}
fn dotenv_key(path: &Path) -> Option<String> {
    if std::fs::metadata(path).ok()?.len() > 65536 {
        return None;
    }
    std::fs::read_to_string(path)
        .ok()?
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("export ")
                .unwrap_or(line.trim())
                .split_once('=')
        })
        .find(|(key, _)| key.trim() == "BOLTS_ADMIN_API_KEY")
        .map(|(_, value)| value.trim().trim_matches(['\'', '"']).to_owned())
}
pub(crate) fn router(hub: Shared) -> Router {
    // An explicit empty environment variable disables the API, even if a local
    // .env has a development key. Production uses systemd's EnvironmentFile.
    let key = std::env::var("BOLTS_ADMIN_API_KEY")
        .ok()
        .or_else(|| dotenv_key(Path::new(".env")));
    router_with_key(hub, key.as_deref())
}
fn router_with_key(hub: Shared, key: Option<&str>) -> Router {
    let database = hub
        .try_lock()
        .expect("initial state")
        .config
        .database
        .clone();
    let state = AdminState {
        hub,
        database,
        key_tag: key_tag(key),
        slots: Arc::new(Semaphore::new(2)),
    };
    Router::new()
        .route("/api/admin/status", get(status))
        .route("/api/admin/query", post(query))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .layer(DefaultBodyLimit::max(16384))
        .with_state(state)
}
fn problem(code: StatusCode, name: &str, message: &str) -> Response {
    (code, Json(error(name, message))).into_response()
}
fn authorized(state: &AdminState, headers: &HeaderMap) -> bool {
    let Some(expected) = state.key_tag else {
        return false;
    };
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return false;
    }
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    (32..=128).contains(&token.len()) && key_mac(token).verify_slice(&expected).is_ok()
}
async fn authenticate(State(state): State<AdminState>, request: Request, next: Next) -> Response {
    let mut response = if state.key_tag.is_none() {
        StatusCode::NOT_FOUND.into_response()
    } else if !authorized(&state, request.headers()) {
        problem(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid admin Bearer key is required.",
        )
    } else {
        let mut hub = state.hub.lock().await;
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok());
        let result = if !hub.allowed_origin(origin) {
            Some(StatusCode::FORBIDDEN.into_response())
        } else if hub.failed || hub.shutting_down {
            Some(problem(
                StatusCode::SERVICE_UNAVAILABLE,
                "server_busy",
                "Server unavailable.",
            ))
        } else {
            let query = request.uri().path() == "/api/admin/query";
            if !hub.allow(
                format!("admin:{}", if query { "query" } else { "status" }),
                if query { 30 } else { 120 },
                60,
            ) {
                Some(problem(
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limited",
                    "Try again shortly.",
                ))
            } else {
                None
            }
        };
        drop(hub);
        if let Some(response) = result {
            response
        } else {
            next.run(request).await
        }
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusRequest {
    #[serde(default = "default_minutes")]
    minutes: u32,
}
fn default_minutes() -> u32 {
    60
}
async fn status(State(state): State<AdminState>, Query(request): Query<StatusRequest>) -> Response {
    if !(1..=10080).contains(&request.minutes) {
        return problem(
            StatusCode::BAD_REQUEST,
            "invalid_minutes",
            "minutes must be between 1 and 10080.",
        );
    }
    let now = db::now_ms();
    let since = now - i64::from(request.minutes) * 60000;
    let current = state.hub.lock().await.online_count();
    read(state,move|conn|{
  let recent:i64=conn.query_row("SELECT count(DISTINCT m.player_id) FROM memberships m JOIN players p ON p.id=m.player_id JOIN connections c ON c.player_id=m.player_id WHERE p.is_bot=0 AND m.joined_at<=?1 AND c.opened_at<=?1 AND min(coalesce(m.left_at,?1),coalesce(c.closed_at,?1),?1)>=max(m.joined_at,c.opened_at,?2)",[now,since],|r|r.get(0))?;
  let browsers_now:i64=conn.query_row("SELECT count(*) FROM visitors WHERE last_seen>=?1 AND last_seen<=?2",[now-90000,now],|r|r.get(0))?;
  let browsers_recent:i64=conn.query_row("SELECT count(DISTINCT visitor_id) FROM visitor_activity WHERE last_seen>=?1 AND first_seen<=?2",[since,now],|r|r.get(0))?;
  Ok(json!({"ok":true,"asOf":now,"minutes":request.minutes,"activeNow":current,"activePastMinutes":recent,"browsersLast90Seconds":browsers_now,"browsersPastMinutes":browsers_recent}))
 }).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryRequest {
    sql: String,
    #[serde(default)]
    parameters: Vec<Value>,
    #[serde(default = "default_rows")]
    max_rows: usize,
}
fn default_rows() -> usize {
    100
}
fn parameters(values: Vec<Value>) -> Option<Vec<SqlValue>> {
    values
        .into_iter()
        .map(|value| {
            Some(match value {
                Value::Null => SqlValue::Null,
                Value::Bool(b) => SqlValue::Integer(i64::from(b)),
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        SqlValue::Integer(i)
                    } else if n.is_f64() {
                        SqlValue::Real(n.as_f64()?)
                    } else {
                        return None;
                    }
                }
                Value::String(s) if s.len() <= 8192 => SqlValue::Text(s),
                _ => return None,
            })
        })
        .collect()
}
async fn query(State(state): State<AdminState>, Json(request): Json<QueryRequest>) -> Response {
    if request.sql.trim().is_empty()
        || request.sql.len() > 8192
        || request.parameters.len() > 64
        || !(1..=500).contains(&request.max_rows)
    {
        return problem(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "Use one SELECT, up to 8192 SQL bytes, 64 parameters and 1–500 rows.",
        );
    }
    let Some(params) = parameters(request.parameters) else {
        return problem(
            StatusCode::BAD_REQUEST,
            "invalid_parameters",
            "Parameters must be SQL-compatible JSON scalars.",
        );
    };
    read(state, move |conn| {
        run_query(conn, &request.sql, &params, request.max_rows)
    })
    .await
}
fn connection(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_millis(100))?;
    conn.pragma_update(None, "query_only", true)?;
    conn.pragma_update(None, "trusted_schema", false)?;
    conn.pragma_update(None, "temp_store", "FILE")?;
    for (limit, value) in [
        (Limit::SQLITE_LIMIT_LENGTH, 65536),
        (Limit::SQLITE_LIMIT_SQL_LENGTH, 8192),
        (Limit::SQLITE_LIMIT_COLUMN, 64),
        (Limit::SQLITE_LIMIT_EXPR_DEPTH, 64),
        (Limit::SQLITE_LIMIT_COMPOUND_SELECT, 16),
        (Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 64),
        (Limit::SQLITE_LIMIT_ATTACHED, 0),
        (Limit::SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 1024),
    ] {
        conn.set_limit(limit, value)?;
    }
    let start = Instant::now();
    let mut operations = 0;
    conn.progress_handler(
        1000,
        Some(move || {
            operations += 1000;
            operations > 250_000 || start.elapsed() > Duration::from_millis(QUERY_MS)
        }),
    )?;
    conn.authorizer(Some(|context: AuthContext<'_>| match context.action {
        AuthAction::Select | AuthAction::Read { .. } | AuthAction::Recursive => {
            Authorization::Allow
        }
        AuthAction::Function { function_name }
            if !["load_extension", "readfile", "writefile", "fts3_tokenizer"]
                .iter()
                .any(|f| function_name.eq_ignore_ascii_case(f)) =>
        {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }))?;
    Ok(conn)
}
fn run_query(
    conn: &Connection,
    sql: &str,
    params: &[SqlValue],
    max_rows: usize,
) -> rusqlite::Result<Value> {
    let mut statement = conn.prepare(sql)?;
    if !statement.readonly() || statement.column_count() == 0 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let columns: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut cursor = statement.query(rusqlite::params_from_iter(params))?;
    let mut rows = Vec::new();
    let mut bytes = 0;
    let mut truncated = false;
    while let Some(row) = cursor.next()? {
        if rows.len() >= max_rows {
            truncated = true;
            break;
        }
        let values: Vec<Value> = (0..columns.len())
            .map(|i| {
                Ok(match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                    ValueRef::Blob(v) => {
                        json!({"hex":v.iter().map(|b|format!("{b:02x}")).collect::<String>()})
                    }
                })
            })
            .collect::<rusqlite::Result<_>>()?;
        bytes += serde_json::to_vec(&values)
            .expect("JSON values serialize")
            .len();
        if bytes > MAX_BYTES {
            truncated = true;
            break;
        }
        rows.push(values);
    }
    Ok(json!({"columns":columns,"rows":rows,"truncated":truncated}))
}
async fn read(
    state: AdminState,
    work: impl FnOnce(&Connection) -> rusqlite::Result<Value> + Send + 'static,
) -> Response {
    let Ok(permit) = state.slots.clone().try_acquire_owned() else {
        return problem(
            StatusCode::TOO_MANY_REQUESTS,
            "admin_busy",
            "Two admin reads are already running.",
        );
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let conn = connection(&state.database)?;
        work(&conn)
    })
    .await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(rusqlite::Error::SqliteFailure(e, _)))
            if e.code == rusqlite::ErrorCode::OperationInterrupted =>
        {
            problem(
                StatusCode::REQUEST_TIMEOUT,
                "query_timeout",
                "Query exceeded its execution budget.",
            )
        }
        Ok(Err(e)) => problem(StatusCode::BAD_REQUEST, "query_rejected", &e.to_string()),
        Err(_) => problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "admin_unavailable",
            "Admin read unavailable.",
        ),
    }
}

#[cfg(test)]
#[path = "admin_tests.rs"]
mod tests;
