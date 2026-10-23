//! cargo run --release --manifest-path server/Cargo.toml --example lobby-capacity -- 4 humans 20
//! Isolated SQLite, real Hub/AI/physics/persistence and wire encoding. No sockets
//! listen and no production files are read. The sink counts encoded traffic;
//! kernel networking, TLS, HTTP and pathological clients are outside this test.
use axum::extract::ws::Message;
use bolts_server::{
    hub::{Config, Hub},
    sim::{Faction, InputFrame},
    transport,
};
use futures_util::Sink;
use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::sync::watch;
struct CountSink(Arc<AtomicU64>);
impl Sink<Message> for CountSink {
    type Error = std::convert::Infallible;
    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        let n = match message {
            Message::Text(t) => t.len(),
            Message::Binary(b) => b.len(),
            _ => 0,
        };
        self.0.fetch_add(n as u64, Ordering::Relaxed);
        Ok(())
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}
fn cpu_seconds() -> Option<f64> {
    let s = std::fs::read_to_string("/proc/self/stat").ok()?;
    let fields: Vec<_> = s.rsplit_once(')')?.1.split_whitespace().collect();
    let ticks: f64 = std::env::var("BENCH_CLOCK_TICKS")
        .unwrap_or_else(|_| "100".into())
        .parse()
        .ok()?;
    Some((fields[11].parse::<f64>().ok()? + fields[12].parse::<f64>().ok()?) / ticks)
}
fn peak_rss_kib() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find(|s| s.starts_with("VmHWM:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<_> = std::env::args().collect();
    let rooms: usize = args.get(1).map(|x| x.parse()).transpose()?.unwrap_or(4);
    let bots = args.get(2).is_some_and(|x| x == "bots");
    let seconds: u64 = args.get(3).map(|x| x.parse()).transpose()?.unwrap_or(20);
    assert!((1..=29).contains(&rooms) && (5..=120).contains(&seconds));
    let directory = tempfile::tempdir()?;
    let mut hub = Hub::new(Config {
        bind: "127.0.0.1:0".into(),
        database: directory.path().join("bench.sqlite"),
        origins: vec![],
        identity_salt: "isolated-capacity-benchmark-identity-salt".into(),
        empty_seconds: 1000.0,
        reconnect_seconds: 30.0,
        max_rooms: rooms + 3,
        proxy: false,
    })?;
    let bytes = Arc::new(AtomicU64::new(0));
    let mut peers = Vec::new();
    let mut metrics = Vec::new();
    let mut dm_peers: Vec<Vec<usize>> = vec![vec![]; rooms];
    for group in 0..rooms + 3 {
        let list = hub.lobbies()?;
        let name = if group < rooms {
            if group == 0 {
                "Deathmatch".into()
            } else {
                format!("Deathmatch {}", group + 1)
            }
        } else {
            ["1v1 Alpha", "1v1 Beta", "1v1 Delta"][group - rooms].into()
        };
        let row = list["lobbies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == name)
            .unwrap();
        let lobby = row["id"].as_str().unwrap().to_owned();
        let count = row["capacity"].as_u64().unwrap();
        for _ in 0..count {
            let (id, _) = hub.db.request(|db| Ok(db.session(None)?.unwrap())).await?;
            let cid = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = transport::channel();
            let (cancel, cancelled) = watch::channel(None);
            metrics.push(tx.metrics.clone());
            tokio::spawn(transport::write_socket(
                CountSink(bytes.clone()),
                rx,
                cancelled,
            ));
            let ip = std::net::Ipv6Addr::from(uuid::Uuid::parse_str(&id)?.as_u128()).to_string();
            hub.register(&id, cid.clone(), tx, cancel, &ip, "capacity-benchmark")?;
            hub.join(
                &id,
                &cid,
                Some(&lobby),
                "Benchmark",
                Faction::British,
                false,
            )?;
            if group < rooms {
                dm_peers[group].push(peers.len());
            }
            peers.push((id, cid, true));
            tokio::task::yield_now().await;
        }
    }
    if bots {
        for group in dm_peers {
            for &i in group.iter().skip(1) {
                hub.leave(&peers[i].0, "bench-bot-scenario", false)?;
                peers[i].2 = false;
            }
        }
    }
    hub.db.request(|_| Ok(())).await?;
    let human_count = peers.iter().filter(|p| p.2).count();
    let mut samples = Vec::new();
    let mut over_budget = 0;
    let mut late = 0;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;
    let occupancy = std::env::var("BENCH_OCCUPANCY_URL").ok();
    let start = tokio::time::Instant::now();
    let mut cpu_start = None;
    let mut byte_start = 0;
    let mut measured = Instant::now();
    for tick in 0..(seconds + 3) * 60 {
        let deadline = start + Duration::from_secs_f64(tick as f64 / 60.0);
        tokio::time::sleep_until(deadline).await;
        if tick % 120 == 0 {
            if let Some(url) = &occupancy {
                let live: serde_json::Value = client
                    .get(url)
                    .send()
                    .await?
                    .error_for_status()?
                    .json()
                    .await?;
                let rows = live["lobbies"].as_array().ok_or("missing occupancy")?;
                if rows
                    .iter()
                    .any(|r| r["players"].as_u64().is_none_or(|n| n > 0))
                {
                    return Err("live players arrived; benchmark stopped".into());
                }
            }
        }
        if tick == 180 {
            cpu_start = cpu_seconds();
            byte_start = bytes.load(Ordering::Relaxed);
            measured = Instant::now();
        }
        let t = Instant::now();
        for (i, (id, cid, _active)) in peers.iter().enumerate().filter(|(_, p)| p.2) {
            let phase = tick as f64 / 60.0 + i as f64;
            hub.input(
                id,
                InputFrame {
                    seq: tick + 1,
                    yaw: phase * 0.7,
                    pitch: (phase * 0.3).sin() * 0.1,
                    forward: 1.0,
                    right: (phase * 0.8).sin(),
                    ads: tick % 240 < 120,
                    fire: tick % 80 == 0,
                    melee: tick % 180 == 0,
                    jump: tick % 210 == 0,
                    reload: tick % 360 == 0,
                    ..Default::default()
                },
            );
            if tick % 600 == i as u64 % 600 {
                hub.chat(id, cid, "Isolated capacity benchmark")?;
            }
        }
        hub.tick()?;
        if tick >= 180 {
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            samples.push(ms);
            if ms > 1000.0 / 60.0 {
                over_budget += 1;
            }
            if tokio::time::Instant::now() > deadline + Duration::from_secs_f64(1.0 / 60.0) {
                late += 1;
            }
        }
    }
    hub.db.request(|_| Ok(())).await?;
    let elapsed = measured.elapsed().as_secs_f64();
    let cpu = cpu_start.zip(cpu_seconds()).map(|(a, b)| (b - a) / elapsed);
    samples.sort_by(f64::total_cmp);
    let percentile = |p: f64| samples[(samples.len() as f64 * p).floor() as usize];
    let replaced: u64 = metrics
        .iter()
        .map(|m| m.snapshots_replaced.load(Ordering::Relaxed))
        .sum();
    let sent: u64 = metrics
        .iter()
        .map(|m| m.snapshots_sent.load(Ordering::Relaxed))
        .sum();
    let output = serde_json::json!({"deathmatchRooms":rooms,"duelRooms":3,"humans":human_count,"bots":if bots{rooms*2}else{0},"measuredSeconds":elapsed,"tickMeanMs":samples.iter().sum::<f64>()/samples.len() as f64,"tickP95Ms":percentile(0.95),"tickP99Ms":percentile(0.99),"tickMaxMs":samples.last(),"overBudgetTicks":over_budget,"lateTicks":late,"cpuCores":cpu,"peakRssKiB":peak_rss_kib(),"encodedEgressMbps":(bytes.load(Ordering::Relaxed)-byte_start) as f64*8.0/elapsed/1e6,"snapshotsSent":sent,"snapshotsReplaced":replaced});
    hub.shutdown()?;
    hub.db.drain().await?;
    println!("{output}");
    Ok(())
}
