use bolts_server::{
    app,
    hub::{Config, Hub},
    tick_clock::{STEP, TickClock},
};
use std::{net::SocketAddr, sync::Arc, time::Instant};
use tokio::sync::Mutex;
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
        let mut report_at = previous;
        let (mut catch_up, mut dropped, mut maximum_lock_ms, mut maximum_tick_ms) =
            (0_u64, 0_u64, 0.0_f64, 0.0_f64);
        loop {
            tokio::select! {
                biased;
                _ = stopping.changed() => break,
                _ = interval.tick() => {},
            }
            let now = Instant::now();
            let batch = clock.advance(now.saturating_duration_since(previous));
            previous = now;
            catch_up += u64::from(batch.steps.saturating_sub(1));
            dropped += batch.dropped;
            for _ in 0..batch.steps {
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
                if let Err(error) = h.tick() {
                    tracing::error!(%error,"persistent event failure; game service stopped");
                    h.fail();
                    tick_fatal.notify_one();
                    return;
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
                    pending_ticks = batch.pending,
                    "simulation timing"
                );
                if dropped > 0 {
                    tracing::warn!(
                        dropped_ticks = dropped,
                        "simulation overload exceeded bounded catch-up"
                    );
                }
                (catch_up, dropped, maximum_lock_ms, maximum_tick_ms) = (0, 0, 0.0, 0.0);
                report_at = now;
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let shutdown_hub = hub.clone();
    tracing::info!(%bind,"Bolts multiplayer listening");
    axum::serve(
        listener,
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
