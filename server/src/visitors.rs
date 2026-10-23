//! Optional first-party visitor activity is independent of player authentication
//! and scores. IP addresses remain private server-side telemetry.
use super::Db;
use rusqlite::params;
use serde::Deserialize;
use std::net::IpAddr;
use uuid::{Uuid, Variant, Version};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VisitEvent {
    SinglePlayerStart,
    SinglePlayerStop,
}
impl VisitEvent {
    fn as_str(self) -> &'static str {
        match self {
            Self::SinglePlayerStart => "single_player_start",
            Self::SinglePlayerStop => "single_player_stop",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StopReason {
    Quit,
    PageExit,
    Restart,
    RoundEnd,
}
impl StopReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Quit => "quit",
            Self::PageExit => "page_exit",
            Self::Restart => "restart",
            Self::RoundEnd => "round_end",
        }
    }
}

#[derive(Debug)]
pub(crate) struct SinglePlayerEvent {
    pub(crate) session_id: Uuid,
    pub(crate) event: VisitEvent,
    pub(crate) reason: Option<StopReason>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct VisitRequest {
    visitor_id: String,
    event: Option<VisitEvent>,
    session_id: Option<String>,
    reason: Option<StopReason>,
}

fn valid_uuid(id: &Uuid) -> bool {
    id.get_version() == Some(Version::Random) && id.get_variant() == Variant::RFC4122
}
fn request_uuid(value: &str) -> Option<Uuid> {
    if value.len() != 36 {
        return None;
    }
    let id = Uuid::parse_str(value).ok()?;
    (valid_uuid(&id) && id.hyphenated().to_string() == value.to_ascii_lowercase()).then_some(id)
}

impl VisitRequest {
    pub(crate) fn is_event(&self) -> bool {
        self.event.is_some()
    }
    pub(crate) fn validate(self) -> Option<(Uuid, Option<SinglePlayerEvent>)> {
        let visitor = request_uuid(&self.visitor_id)?;
        let event = match (self.event, self.session_id) {
            (None, None) if self.reason.is_none() => None,
            (Some(event), Some(session))
                if event == VisitEvent::SinglePlayerStop || self.reason.is_none() =>
            {
                Some(SinglePlayerEvent {
                    session_id: request_uuid(&session)?,
                    event,
                    reason: self.reason,
                })
            }
            _ => return None,
        };
        Some((visitor, event))
    }
}

impl Db {
    /// Backwards-compatible receipt helper for non-network callers.
    #[cfg(test)]
    pub fn record_visit(&mut self, visitor_id: &Uuid, at: i64) -> rusqlite::Result<()> {
        self.record_visitor_activity(visitor_id, None, None, at)
    }

    /// IP and time come from the server, never request JSON. Receipts retain
    /// minute buckets; session/event keys make best-effort retries idempotent.
    pub(crate) fn record_visitor_activity(
        &mut self,
        visitor_id: &Uuid,
        ip: Option<IpAddr>,
        event: Option<&SinglePlayerEvent>,
        at: i64,
    ) -> rusqlite::Result<()> {
        if !valid_uuid(visitor_id)
            || at < 0
            || event.is_some_and(|e| {
                !valid_uuid(&e.session_id)
                    || e.event == VisitEvent::SinglePlayerStart && e.reason.is_some()
            })
        {
            return Err(rusqlite::Error::InvalidParameterName(
                "UUIDv4 IDs, valid lifecycle fields and nonnegative server timestamp required"
                    .into(),
            ));
        }
        let ip = ip.map(|ip| crate::limits::canonical_ip(&ip.to_string()));
        let id = visitor_id.hyphenated().to_string();
        let bucket = at / 60_000 * 60_000;
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO visitors(id,first_seen,last_seen) VALUES(?1,?2,?2)
             ON CONFLICT(id) DO UPDATE SET
             first_seen=min(visitors.first_seen,excluded.first_seen),
             last_seen=max(visitors.last_seen,excluded.last_seen)",
            params![id, at],
        )?;
        tx.execute(
            "INSERT INTO visitor_activity(visitor_id,bucket_start,first_seen,last_seen)
             VALUES(?1,?2,?3,?3) ON CONFLICT(visitor_id,bucket_start) DO UPDATE SET
             first_seen=min(visitor_activity.first_seen,excluded.first_seen),
             last_seen=max(visitor_activity.last_seen,excluded.last_seen)",
            params![id, bucket, at],
        )?;
        if let Some(ip) = &ip {
            tx.execute(
                "INSERT INTO visitor_networks(visitor_id,ip_address,first_seen,last_seen)
                 VALUES(?1,?2,?3,?3) ON CONFLICT(visitor_id,ip_address) DO UPDATE SET
                 first_seen=min(visitor_networks.first_seen,excluded.first_seen),
                 last_seen=max(visitor_networks.last_seen,excluded.last_seen)",
                params![id, ip, at],
            )?;
        }
        if let Some(event) = event {
            tx.execute(
                "INSERT INTO single_player_events(visitor_id,session_id,event,at,ip_address,reason)
                 VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(visitor_id,session_id,event) DO NOTHING",
                params![
                    id,
                    event.session_id.hyphenated().to_string(),
                    event.event.as_str(),
                    at,
                    ip,
                    event.reason.map(StopReason::as_str),
                ],
            )?;
        }
        tx.commit()
    }
}
