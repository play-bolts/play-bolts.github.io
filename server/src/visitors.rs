//! Anonymous visitor activity has no relationship to player authentication or
//! score data. Only random visitor UUIDs and server-generated times are stored.
use super::Db;
use rusqlite::params;
use serde::Deserialize;
use uuid::{Uuid, Variant, Version};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct VisitRequest {
    visitor_id: String,
}

impl VisitRequest {
    pub(crate) fn visitor_id(&self) -> Option<Uuid> {
        if self.visitor_id.len() != 36 {
            return None;
        }
        let id = Uuid::parse_str(&self.visitor_id).ok()?;
        (id.get_version() == Some(Version::Random)
            && id.get_variant() == Variant::RFC4122
            && id.hyphenated().to_string() == self.visitor_id.to_ascii_lowercase())
        .then_some(id)
    }
}

impl Db {
    /// `at` must come from the server clock, never from a request field. Minute
    /// buckets retain history without writing a separate row for each heartbeat.
    pub fn record_visit(&mut self, visitor_id: &Uuid, at: i64) -> rusqlite::Result<()> {
        if visitor_id.get_version() != Some(Version::Random)
            || visitor_id.get_variant() != Variant::RFC4122
            || at < 0
        {
            return Err(rusqlite::Error::InvalidParameterName(
                "visitor UUIDv4 and nonnegative server timestamp required".into(),
            ));
        }
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
        tx.commit()
    }
}
