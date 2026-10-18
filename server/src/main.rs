use axum::serve::{ListenerExt, TapIo};
use bolts_server::{
    app,
    hub::{Config, Hub},
    tick_clock::{STEP, TickClock},
    transport::SnapshotPacer,
};
use std::{net::SocketAddr, sync::Arc, time::Instant};
use tokio::sync::Mutex;

fn realtime_listener(
    listener: tokio::net::TcpListener,
) -> TapIo<tokio::net::TcpListener, fn(&mut tokio::net::TcpStream)> {
    listener.tap_io(|stream| {
        // Small combat cues and ping replies must leave immediately instead of
        // waiting for Nagle's algorithm and the peer's delayed acknowledgement.
        if let Err(error) = stream.set_nodelay(true) {
            tracing::warn!(%error, "failed to disable TCP batching");
        }
    })
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "bolts_server=info,tower_http=warn".into()),
        )
        .init();
    let config = Config::from_env()?;
    let bind: SocketAddr = config.bind.parse()?;
    let mut initial = Hub::new(config)?;
    if let Ok(token) = std::env::var("BOLTS_INTERNAL_TOKEN") {
        if token.len() < 32 || !bind.ip().is_loopback() {
            return Err(
                "Internal cluster API requires a loopback bind and a 32-character token".into(),
            );
        }
        initial.internal_token = Some(token);
    }
    let hub = Arc::new(Mutex::new(initial));
    // Router construction reads immutable origin policy with try_lock; finish
    // it before the simulation task can acquire the shared state.
    let application = app::router(hub.clone());
    let runner = hub.clone();
    let fatal = Arc::new(tokio::sync::Notify::new());
    let tick_fatal = fatal.clone();
    let (stop_ticks, mut stopping) = tokio::sync::watch::channel(false);
    let tick_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + STEP, STEP);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut previous = Instant::now();
        let mut clock = TickClock::default();
        let mut snapshots = SnapshotPacer::default();
        let mut report_at = previous;
        let (
            mut catch_up,
            mut dropped,
            mut maximum_lock_ms,
            mut maximum_tick_ms,
            mut maximum_wake_delay_ms,
        ) = (0_u64, 0_u64, 0.0_f64, 0.0_f64, 0.0_f64);
        loop {
            tokio::select! {
                biased;
                _ = stopping.changed() => break,
                _ = interval.tick() => {},
            }
            let now = Instant::now();
            let elapsed = now.saturating_duration_since(previous);
            maximum_wake_delay_ms =
                maximum_wake_delay_ms.max(elapsed.saturating_sub(STEP).as_secs_f64() * 1000.0);
            let batch = clock.advance(elapsed);
            previous = now;
            catch_up += u64::from(batch.steps.saturating_sub(1));
            dropped += batch.dropped;
            for step in 0..batch.steps {
                if *stopping.borrow() {
                    return;
                }
                let waiting = Instant::now();
                let mut h = runner.lock().await;
                let started = Instant::now();
                maximum_lock_ms =
                    maximum_lock_ms.max(started.duration_since(waiting).as_secs_f64() * 1000.0);
                if h.failed {
                    tick_fatal.notify_one();
                    return;
                }
                // Capture only the newest state once the batch has caught up;
                // a wall-clock gate also bounds publication across batches.
                let publish = step + 1 == batch.steps && snapshots.ready(Instant::now());
                match h.tick_with_publication(publish) {
                    Ok(true) => snapshots.published(Instant::now()),
                    Ok(false) => {}
                    Err(error) => {
                        tracing::error!(%error,"persistent event failure; game service stopped");
                        h.fail();
                        tick_fatal.notify_one();
                        return;
                    }
                }
                maximum_tick_ms = maximum_tick_ms.max(started.elapsed().as_secs_f64() * 1000.0);
                drop(h);
                // Catch-up cannot monopolize admission or incoming commands.
                if batch.steps > 1 {
                    tokio::task::yield_now().await;
                }
            }
            if now.duration_since(report_at).as_secs() >= 5 {
                tracing::debug!(
                    catch_up_ticks = catch_up,
                    dropped_ticks = dropped,
                    max_lock_ms = maximum_lock_ms,
                    max_tick_ms = maximum_tick_ms,
                    max_wake_delay_ms = maximum_wake_delay_ms,
                    pending_ticks = batch.pending,
                    "simulation timing"
                );
                // Keep occasional stalls visible with the production info log
                // level, without requiring verbose per-socket/tick diagnostics.
                if dropped > 0
                    || maximum_lock_ms >= 50.0
                    || maximum_tick_ms >= 50.0
                    || maximum_wake_delay_ms >= 100.0
                {
                    tracing::warn!(
                        catch_up_ticks = catch_up,
                        dropped_ticks = dropped,
                        max_lock_ms = maximum_lock_ms,
                        max_tick_ms = maximum_tick_ms,
                        max_wake_delay_ms = maximum_wake_delay_ms,
                        "simulation latency spike"
                    );
                }
                (
                    catch_up,
                    dropped,
                    maximum_lock_ms,
                    maximum_tick_ms,
                    maximum_wake_delay_ms,
                ) = (0, 0, 0.0, 0.0, 0.0);
                report_at = now;
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let shutdown_hub = hub.clone();
    tracing::info!(%bind,"Bolts multiplayer listening");
    axum::serve(
        realtime_listener(listener),
        application.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{},_=fatal.notified()=>{}}
        }
        #[cfg(not(unix))]
        {
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=fatal.notified()=>{}}
        }
        let _ = stop_ticks.send(true);
        let _ = tick_task.await;
        let storage = {
            let mut hub = shutdown_hub.lock().await;
            if let Err(error) = hub.shutdown() {
                tracing::error!(%error, "shutdown persistence failed; recovery will run on restart");
                hub.fail();
            }
            hub.db.clone()
        };
        if let Err(error) = storage.drain().await {
            tracing::error!(%error, "shutdown persistence failed; recovery will run on restart");
            shutdown_hub.lock().await.fail();
        }
    })
    .await?;

    if hub.lock().await.failed {
        Err("Persistent storage failure".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::serve::Listener;

    #[tokio::test]
    async fn accepted_game_connections_disable_tcp_batching() {
        let raw = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = raw.local_addr().unwrap();
        let mut listener = realtime_listener(raw);
        // Exercise the actual acceptance wrapper used by axum, including each
        // new connection rather than just setting an option on a test socket.
        for _ in 0..2 {
            let (connected, (accepted, _)) =
                tokio::join!(tokio::net::TcpStream::connect(address), listener.accept(),);
            let _client = connected.unwrap();
            assert!(accepted.nodelay().unwrap());
        }
    }
}
