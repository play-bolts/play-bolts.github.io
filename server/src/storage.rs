//! SQLite is owned by one dedicated thread. The simulation only enqueues bounded
//! FIFO work; it never waits for a filesystem lock, commit, or read. Durable
//! notifications use `committed()` tickets and are published after commit.
use crate::db::{self, Db, EventRow};
use rusqlite::{params, types::Value as SqlValue};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Instant,
};
use tokio::sync::oneshot;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const CAPACITY: usize = 1024;
const MAX_QUEUED_BYTES: usize = 32 * 1024 * 1024;
const MAX_OPTIONAL_BYTES: usize = 16 * 1024 * 1024;
type Work = Box<dyn FnOnce(&mut Db) -> Result<()> + Send>;
struct Job {
    ticket: u64,
    critical: bool,
    bytes: usize,
    queued: Instant,
    at: i64,
    work: Work,
    done: Option<oneshot::Sender<Result<()>>>,
}
#[derive(Default)]
struct Status {
    committed: AtomicU64,
    failure: Mutex<Option<String>>,
    queued_bytes: AtomicU64,
    queued_jobs: AtomicU64,
    optional_jobs: AtomicU64,
    optional_bytes: AtomicU64,
}
struct Submission {
    sender: mpsc::SyncSender<Job>,
    next: u64,
    closed: bool,
    capacity: usize,
}
#[derive(Clone)]
pub struct Storage {
    submission: Arc<Mutex<Submission>>,
    status: Arc<Status>,
    bots: Arc<Mutex<HashMap<String, String>>>,
}
impl Storage {
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_capacity(path, CAPACITY)
    }
    fn open_with_capacity(path: &Path, capacity: usize) -> Result<Self> {
        let mut db = Db::open(path)?;
        let bots = {
            let mut s = db
                .conn
                .prepare("SELECT bot_key,id FROM players WHERE is_bot=1 AND bot_key IS NOT NULL")?;
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<HashMap<String, String>>>()?
        };
        let (sender, receiver) = mpsc::sync_channel::<Job>(capacity);
        let status = Arc::new(Status::default());
        let worker_status = status.clone();
        std::thread::Builder::new()
            .name("bolts-sqlite".into())
            .spawn(move || {
                let mut pending = VecDeque::new();
                loop {
                    if pending.is_empty() {
                        let Ok(job) = receiver.recv() else {
                            break;
                        };
                        pending.push_back(job);
                    }
                    pending.extend(receiver.try_iter());
                    // Preserve gameplay FIFO, but do not let optional analytics or
                    // leaderboard requests accumulate ahead of combat persistence.
                    let index = pending.iter().position(|job| job.critical).unwrap_or(0);
                    let job = pending.remove(index).unwrap();
                    let result = if worker_status.failure.lock().unwrap().is_some() && job.critical
                    {
                        Err("persistent storage already failed".into())
                    } else {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            db::at_time(job.at, || (job.work)(&mut db))
                        }))
                        .unwrap_or_else(|_| Err("storage worker panicked".into()))
                    };
                    worker_status
                        .queued_bytes
                        .fetch_sub(job.bytes as u64, Ordering::Relaxed);
                    worker_status.queued_jobs.fetch_sub(1, Ordering::Relaxed);
                    if !job.critical {
                        worker_status.optional_jobs.fetch_sub(1, Ordering::Relaxed);
                        worker_status
                            .optional_bytes
                            .fetch_sub(job.bytes as u64, Ordering::Relaxed);
                    }
                    if let Err(error) = &result {
                        tracing::error!(%error, ticket=job.ticket, "storage job failed");
                        if job.critical {
                            worker_status
                                .failure
                                .lock()
                                .unwrap()
                                .get_or_insert_with(|| error.to_string());
                        }
                    }
                    // Never advance the durable high-water mark past a failed write.
                    if worker_status.failure.lock().unwrap().is_none() {
                        worker_status
                            .committed
                            .fetch_max(job.ticket, Ordering::Release);
                    }
                    if let Some(done) = job.done {
                        let _ = done.send(result);
                    }
                    let elapsed = job.queued.elapsed();
                    if elapsed.as_millis() > 100 {
                        tracing::warn!(
                            ticket = job.ticket,
                            latency_ms = elapsed.as_millis(),
                            "storage queue latency"
                        );
                    }
                }
            })?;
        Ok(Self {
            submission: Arc::new(Mutex::new(Submission {
                sender,
                next: 1,
                closed: false,
                capacity,
            })),
            status,
            bots: Arc::new(Mutex::new(bots)),
        })
    }
    pub fn check(&self) -> Result<()> {
        match self.status.failure.lock().unwrap().as_ref() {
            Some(message) => Err(message.clone().into()),
            None => Ok(()),
        }
    }
    pub fn committed(&self) -> u64 {
        self.status.committed.load(Ordering::Acquire)
    }
    fn enqueue(&self, critical: bool, bytes: usize, work: Work) -> Result<u64> {
        let mut submission = self.submission.lock().unwrap();
        if submission.closed {
            return Err("storage is draining".into());
        }
        if critical {
            self.check()?;
        }
        // Optional traffic cannot fill capacity reserved for combat/lifecycle
        // writes. Reject its requests with 503 without poisoning live games.
        if !critical
            && (self.status.optional_jobs.load(Ordering::Relaxed)
                >= (submission.capacity / 4).max(1) as u64
                || self
                    .status
                    .optional_bytes
                    .load(Ordering::Relaxed)
                    .saturating_add(bytes as u64)
                    > MAX_OPTIONAL_BYTES as u64)
        {
            return Err("optional storage queue exhausted".into());
        }
        if self
            .status
            .queued_bytes
            .load(Ordering::Relaxed)
            .saturating_add(bytes as u64)
            > MAX_QUEUED_BYTES as u64
            || self.status.queued_jobs.load(Ordering::Relaxed) >= submission.capacity as u64 + 1
        {
            if critical {
                *self.status.failure.lock().unwrap() =
                    Some("durable storage queue exhausted".into());
            }
            return Err("storage queue exhausted".into());
        }
        let ticket = submission.next;
        self.status
            .queued_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
        self.status.queued_jobs.fetch_add(1, Ordering::Relaxed);
        if !critical {
            self.status.optional_jobs.fetch_add(1, Ordering::Relaxed);
            self.status
                .optional_bytes
                .fetch_add(bytes as u64, Ordering::Relaxed);
        }
        if let Err(error) = submission.sender.try_send(Job {
            ticket,
            critical,
            bytes,
            queued: Instant::now(),
            at: db::now_ms(),
            work,
            done: None,
        }) {
            self.status
                .queued_bytes
                .fetch_sub(bytes as u64, Ordering::Relaxed);
            self.status.queued_jobs.fetch_sub(1, Ordering::Relaxed);
            if !critical {
                self.status.optional_jobs.fetch_sub(1, Ordering::Relaxed);
                self.status
                    .optional_bytes
                    .fetch_sub(bytes as u64, Ordering::Relaxed);
            }
            if critical {
                *self.status.failure.lock().unwrap() =
                    Some("durable storage queue unavailable".into());
            }
            return Err(error.to_string().into());
        }
        submission.next += 1;
        Ok(ticket)
    }
    pub fn write(&self, work: impl FnOnce(&mut Db) -> Result<()> + Send + 'static) -> Result<u64> {
        self.enqueue(true, 8192, Box::new(work))
    }
    pub async fn request<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Db) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.request_sized(4096, work).await
    }
    pub async fn request_sized<T: Send + 'static>(
        &self,
        bytes: usize,
        work: impl FnOnce(&mut Db) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.enqueue(
            false,
            bytes,
            Box::new(move |db| {
                let _ = tx.send(work(db));
                Ok(())
            }),
        )?;
        rx.await.map_err(|_| "storage worker stopped")?
    }
    /// Call after producers stop and Hub::shutdown enqueues final lifecycle rows.
    /// FIFO barrier waits for every accepted write and checkpoints outside Hub.
    pub async fn drain(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        let (sender, job) = {
            let mut submission = self.submission.lock().unwrap();
            if submission.closed {
                return Err("storage already draining".into());
            }
            // Close admission before installing the barrier. Even already-running
            // HTTP producers cannot enqueue behind the shutdown checkpoint.
            submission.closed = true;
            let ticket = submission.next;
            submission.next += 1;
            self.status.queued_bytes.fetch_add(1, Ordering::Relaxed);
            self.status.queued_jobs.fetch_add(1, Ordering::Relaxed);
            self.status.optional_jobs.fetch_add(1, Ordering::Relaxed);
            self.status.optional_bytes.fetch_add(1, Ordering::Relaxed);
            let job = Job {
                ticket,
                critical: false,
                bytes: 1,
                queued: Instant::now(),
                at: db::now_ms(),
                work: Box::new(move |db| {
                    db.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
                    Ok(())
                }),
                done: Some(tx),
            };
            (submission.sender.clone(), job)
        };
        // A full queue must drain, not discard its accepted writes at shutdown.
        // Blocking send is isolated from both the async executor and Hub lock.
        tokio::task::spawn_blocking(move || sender.send(job).map_err(|_| "storage worker stopped"))
            .await??;
        let result: Result<()> = rx.await.map_err(|_| "storage worker stopped")?;
        result?;
        self.check()
    }
    pub fn execute(&self, sql: &'static str, values: Vec<SqlValue>) -> Result<u64> {
        self.write(move |db| {
            db.conn.execute(sql, rusqlite::params_from_iter(values))?;
            Ok(())
        })
    }
    pub fn event(&self, e: EventRow<'_>) -> Result<u64> {
        let (kind, lobby, game, connection, actor, target, data) = (
            e.kind.to_owned(),
            e.lobby.map(str::to_owned),
            e.game.map(str::to_owned),
            e.connection.map(str::to_owned),
            e.actor.map(str::to_owned),
            e.target.map(str::to_owned),
            e.data,
        );
        self.write(move |db| {
            db.event(EventRow {
                kind: &kind,
                lobby: lobby.as_deref(),
                game: game.as_deref(),
                connection: connection.as_deref(),
                actor: actor.as_deref(),
                target: target.as_deref(),
                data,
            })?;
            Ok(())
        })
    }
    pub fn connect(&self, cid: &str, player: &str, ip: &str, ua: &str) -> Result<u64> {
        let (cid, player, ip, ua) = (
            cid.to_owned(),
            player.to_owned(),
            ip.to_owned(),
            ua.to_owned(),
        );
        self.write(move |db| {
            db.connect(&cid, &player, &ip, &ua)?;
            Ok(())
        })
    }
    pub fn disconnect(&self, cid: &str, reason: &str) -> Result<u64> {
        let (cid, reason) = (cid.to_owned(), reason.to_owned());
        self.write(move |db| {
            db.disconnect(&cid, &reason)?;
            Ok(())
        })
    }
    pub fn set_name(&self, player: &str, name: &str) -> Result<u64> {
        let (player, name) = (player.to_owned(), name.to_owned());
        self.write(move |db| {
            db.set_name(&player, &name)?;
            Ok(())
        })
    }
    pub fn create_lobby(&self, lobby: &str, name: &str) -> Result<u64> {
        let (lobby, name) = (lobby.to_owned(), name.to_owned());
        self.write(move |db| {
            db.create_lobby(&lobby, &name)?;
            Ok(())
        })
    }
    pub fn create_match(&self, game: &str, lobby: &str, round: u64) -> Result<u64> {
        let (game, lobby) = (game.to_owned(), lobby.to_owned());
        self.write(move |db| {
            db.create_match(&game, &lobby, round)?;
            Ok(())
        })
    }
    pub fn ensure_bot(&self, key: &str, name: &str) -> Result<String> {
        let mut bots = self.bots.lock().unwrap();
        let player = bots.entry(key.to_owned()).or_insert_with(db::id).clone();
        let (key, name, expected) = (key.to_owned(), name.to_owned(), player.clone());
        self.write(move |db| {
            db.conn.execute("INSERT INTO players(id,credential_hash,display_name,created_at,last_seen,is_bot,bot_key) VALUES(?1,?2,?3,?4,?4,1,?5) ON CONFLICT(bot_key) WHERE bot_key IS NOT NULL DO UPDATE SET display_name=excluded.display_name,last_seen=excluded.last_seen",params![expected,format!("bot:{expected}"),name,db::now_ms(),key])?;
            Ok(())
        })?;
        Ok(player)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn join(
        &self,
        membership: &str,
        lobby: &str,
        game: &str,
        player: &str,
        actor: u32,
        name: &str,
        faction: &str,
        cid: &str,
        spectator: bool,
    ) -> Result<u64> {
        let (membership, lobby, game, player, name, faction, cid) = (
            membership.to_owned(),
            lobby.to_owned(),
            game.to_owned(),
            player.to_owned(),
            name.to_owned(),
            faction.to_owned(),
            cid.to_owned(),
        );
        self.write(move |db| {
            db.join(
                &membership,
                &lobby,
                &game,
                &player,
                actor,
                &name,
                &faction,
                &cid,
                spectator,
            )?;
            Ok(())
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn join_bot(
        &self,
        membership: &str,
        lobby: &str,
        game: &str,
        player: &str,
        actor: u32,
        name: &str,
        faction: &str,
    ) -> Result<u64> {
        let (membership, lobby, game, player, name, faction) = (
            membership.to_owned(),
            lobby.to_owned(),
            game.to_owned(),
            player.to_owned(),
            name.to_owned(),
            faction.to_owned(),
        );
        self.write(move |db| {
            db.join_bot(&membership, &lobby, &game, &player, actor, &name, &faction)?;
            Ok(())
        })
    }
    pub fn leave(
        &self,
        membership: &str,
        lobby: &str,
        game: &str,
        player: &str,
        reason: &str,
    ) -> Result<u64> {
        let (membership, lobby, game, player, reason) = (
            membership.to_owned(),
            lobby.to_owned(),
            game.to_owned(),
            player.to_owned(),
            reason.to_owned(),
        );
        self.write(move |db| {
            db.leave(&membership, &lobby, &game, &player, &reason)?;
            Ok(())
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn kill(
        &self,
        lobby: &str,
        game: &str,
        killer: &str,
        victim: &str,
        weapon: &str,
        headshot: bool,
        data: Value,
    ) -> Result<u64> {
        let (lobby, game, killer, victim, weapon) = (
            lobby.to_owned(),
            game.to_owned(),
            killer.to_owned(),
            victim.to_owned(),
            weapon.to_owned(),
        );
        self.write(move |db| {
            db.kill(&lobby, &game, &killer, &victim, &weapon, headshot, data)?;
            Ok(())
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn chat(
        &self,
        lobby: &str,
        game: &str,
        player: &str,
        cid: &str,
        name: &str,
        text: &str,
    ) -> Result<(u64, String, i64)> {
        let (lobby, game, player, cid, name, text) = (
            lobby.to_owned(),
            game.to_owned(),
            player.to_owned(),
            cid.to_owned(),
            name.to_owned(),
            text.to_owned(),
        );
        let eid = db::id();
        let at = db::now_ms();
        let id = eid.clone();
        let ticket = self.write(move |db| {
            db.chat_at(&lobby, &game, &player, &cid, &name, &text, &id, at)?;
            Ok(())
        })?;
        Ok((ticket, eid, at))
    }
    #[cfg(test)]
    pub(crate) fn test_call<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Db) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = mpsc::channel();
        self.enqueue(
            false,
            4096,
            Box::new(move |db| {
                let _ = tx.send(work(db));
                Ok(())
            }),
        )?;
        rx.recv().map_err(|_| "storage worker stopped")?
    }
    #[cfg(test)]
    pub(crate) fn session(&self, token: Option<&str>) -> Result<Option<(String, String)>> {
        let token = token.map(str::to_owned);
        self.test_call(move |db| Ok(db.session(token.as_deref())?))
    }
    #[cfg(test)]
    pub(crate) fn leaderboard(&self, at: i64) -> Result<db::Leaderboard> {
        self.test_call(move |db| Ok(db.leaderboard(at)?))
    }
}

// Test fixtures inspect the actual worker-owned connection through a FIFO
// barrier. This synchronous adapter is intentionally unavailable in production.
#[cfg(test)]
pub(crate) struct TestConnection(Storage);
#[cfg(test)]
impl Storage {
    pub(crate) fn test_conn(&self) -> TestConnection {
        TestConnection(self.clone())
    }
}
#[cfg(test)]
impl TestConnection {
    pub fn query_row<T: Send + 'static, F>(
        &self,
        sql: &str,
        parameters: &[&dyn rusqlite::ToSql],
        map: F,
    ) -> Result<T>
    where
        F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T> + Send + 'static,
    {
        let sql = sql.to_owned();
        let values = Self::values(parameters)?;
        self.0.test_call(move |db| {
            Ok(db
                .conn
                .query_row(&sql, rusqlite::params_from_iter(values), map)?)
        })
    }
    fn values(parameters: &[&dyn rusqlite::ToSql]) -> Result<Vec<SqlValue>> {
        parameters
            .iter()
            .map(|v| {
                Ok(match v.to_sql()? {
                    rusqlite::types::ToSqlOutput::Borrowed(v) => v.try_into()?,
                    rusqlite::types::ToSqlOutput::Owned(v) => v,
                    _ => return Err("unsupported test parameter".into()),
                })
            })
            .collect()
    }
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        let sql = sql.to_owned();
        self.0.test_call(move |db| {
            db.conn.execute_batch(&sql)?;
            Ok(())
        })
    }
    pub fn total_changes(&self) -> u64 {
        self.0.test_call(|db| Ok(db.conn.total_changes())).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;
    #[tokio::test]
    async fn writer_lock_does_not_block_submission_and_commit_ticket_waits_for_disk() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let storage = Storage::open(&path).unwrap();
        let lock = rusqlite::Connection::open(&path).unwrap();
        lock.execute_batch("BEGIN IMMEDIATE").unwrap();
        let at = db::now_ms();
        let before = Instant::now();
        let ticket = storage
            .event(EventRow {
                kind: "round_end",
                lobby: None,
                game: None,
                connection: None,
                actor: None,
                target: None,
                data: json!({}),
            })
            .unwrap();
        assert!(before.elapsed() < Duration::from_millis(100));
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            storage.committed() < ticket,
            "uncommitted events cannot be acknowledged"
        );
        lock.execute_batch("ROLLBACK").unwrap();
        let (count, recorded): (i64, i64) = storage
            .request(|db| {
                Ok(db.conn.query_row(
                    "SELECT count(*),at FROM events WHERE event_type='round_end'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert!(
            recorded - at < 100,
            "queued events retain occurrence time rather than delayed commit time"
        );
        assert!(storage.committed() >= ticket);
        storage.drain().await.unwrap();
    }
    #[tokio::test]
    async fn optional_request_failure_does_not_poison_gameplay_but_durable_failure_does() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("events.sqlite")).unwrap();
        assert!(
            storage
                .request::<()>(|_| Err("analytics failure".into()))
                .await
                .is_err()
        );
        storage.check().unwrap();
        let ticket = storage
            .write(|_| Err("combat disk failure".into()))
            .unwrap();
        storage.request(|_| Ok(())).await.unwrap();
        assert!(storage.check().is_err());
        assert!(storage.committed() < ticket);
        assert!(storage.write(|_| Ok(())).is_err());
        assert!(storage.drain().await.is_err());
    }
    #[test]
    fn bounded_queue_fails_closed_without_waiting_or_silently_dropping_durable_records() {
        let directory = tempfile::tempdir().unwrap();
        let storage =
            Storage::open_with_capacity(&directory.path().join("events.sqlite"), 1).unwrap();
        let (started, wait) = mpsc::channel();
        let (release, block) = mpsc::channel();
        storage
            .write(move |_| {
                started.send(()).unwrap();
                block.recv().unwrap();
                Ok(())
            })
            .unwrap();
        wait.recv_timeout(Duration::from_secs(1)).unwrap();
        storage.write(|_| Ok(())).unwrap();
        let before = Instant::now();
        assert!(storage.write(|_| Ok(())).is_err());
        assert!(before.elapsed() < Duration::from_millis(100));
        assert!(storage.check().is_err());
        release.send(()).unwrap();
    }
    #[tokio::test]
    async fn shutdown_closes_admission_drains_fifo_and_checkpoints_all_accepted_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let storage = Storage::open(&path).unwrap();
        for index in 0..32 {
            storage
                .event(EventRow {
                    kind: "round_end",
                    lobby: None,
                    game: None,
                    connection: None,
                    actor: None,
                    target: None,
                    data: json!({"index":index}),
                })
                .unwrap();
        }
        storage.drain().await.unwrap();
        assert!(storage.write(|_| Ok(())).is_err());
        assert!(storage.request(|_| Ok(())).await.is_err());
        let conn = rusqlite::Connection::open(&path).unwrap();
        let mut statement=conn.prepare("SELECT json_extract(data,'$.index') FROM events WHERE event_type='round_end' ORDER BY seq").unwrap();
        let indexes = statement
            .query_map([], |r| r.get::<_, i64>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(indexes, (0..32).collect::<Vec<_>>());
    }
}

#[cfg(test)]
mod priority_tests {
    use super::*;
    #[tokio::test]
    async fn critical_fifo_overtakes_queued_optional_work_without_regressing_commit_or_skipping_drain()
     {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("events.sqlite")).unwrap();
        let (started, wait) = mpsc::channel();
        let (release, block) = mpsc::channel();
        storage
            .write(move |_| {
                started.send(()).unwrap();
                block.recv().unwrap();
                Ok(())
            })
            .unwrap();
        wait.recv().unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let at_optional = Arc::new(AtomicU64::new(0));
        let (record, status, observed) =
            (order.clone(), storage.status.clone(), at_optional.clone());
        storage
            .enqueue(
                false,
                1,
                Box::new(move |_| {
                    record.lock().unwrap().push("optional-first");
                    observed.store(status.committed.load(Ordering::Acquire), Ordering::Release);
                    Ok(())
                }),
            )
            .unwrap();
        let record = order.clone();
        let first_critical = storage
            .write(move |_| {
                record.lock().unwrap().push("critical-first");
                Ok(())
            })
            .unwrap();
        let record = order.clone();
        let second_critical = storage
            .write(move |_| {
                record.lock().unwrap().push("critical-second");
                Ok(())
            })
            .unwrap();
        let record = order.clone();
        storage
            .enqueue(
                false,
                1,
                Box::new(move |_| {
                    record.lock().unwrap().push("optional-last");
                    Ok(())
                }),
            )
            .unwrap();
        release.send(()).unwrap();
        storage.drain().await.unwrap();
        assert_eq!(
            *order.lock().unwrap(),
            [
                "critical-first",
                "critical-second",
                "optional-first",
                "optional-last"
            ]
        );
        assert!(at_optional.load(Ordering::Acquire) >= second_critical);
        assert!(storage.committed() >= second_critical && second_critical > first_critical);
    }
}

#[cfg(test)]
mod reservation_tests {
    use super::*;
    #[tokio::test]
    async fn optional_flood_is_rejected_without_consuming_reserved_gameplay_capacity() {
        let directory = tempfile::tempdir().unwrap();
        let storage =
            Storage::open_with_capacity(&directory.path().join("events.sqlite"), 8).unwrap();
        let (started, wait) = mpsc::channel();
        let (release, block) = mpsc::channel();
        storage
            .write(move |_| {
                started.send(()).unwrap();
                block.recv().unwrap();
                Ok(())
            })
            .unwrap();
        wait.recv().unwrap();
        for _ in 0..2 {
            storage.enqueue(false, 4096, Box::new(|_| Ok(()))).unwrap();
        }
        assert!(storage.enqueue(false, 4096, Box::new(|_| Ok(()))).is_err());
        storage.check().unwrap();
        let ticket = storage.write(|_| Ok(())).unwrap();
        release.send(()).unwrap();
        storage.drain().await.unwrap();
        assert!(storage.committed() >= ticket);
        assert_eq!(storage.status.optional_jobs.load(Ordering::Relaxed), 0);
        assert_eq!(storage.status.queued_jobs.load(Ordering::Relaxed), 0);
    }
}
