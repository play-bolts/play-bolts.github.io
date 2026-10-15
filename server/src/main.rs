use bolts_server::{
    app,
    hub::{Config, Hub},
};
use std::{net::SocketAddr, sync::Arc};
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
    let hub = Arc::new(Mutex::new(Hub::new(config)?));
    let runner = hub.clone();
    let fatal = Arc::new(tokio::sync::Notify::new());
    let tick_fatal = fatal.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs_f64(1.0 / 60.0));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let mut h = runner.lock().await;
            if h.failed {
                tick_fatal.notify_one();
                break;
            }
            if let Err(error) = h.tick() {
                tracing::error!(%error,"persistent event failure; game service stopped");
                h.fail();
                tick_fatal.notify_one();
                break;
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let shutdown_hub = hub.clone();
    tracing::info!(%bind,"Bolts multiplayer listening");
    axum::serve(
        listener,
        app::router(hub.clone()).into_make_service_with_connect_info::<SocketAddr>(),
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
        if let Err(error) = shutdown_hub.lock().await.shutdown() {
            tracing::error!(%error, "shutdown persistence failed; recovery will run on restart");
        }
    })
    .await?;

    if hub.lock().await.failed {
        Err("Persistent storage failure".into())
    } else {
        Ok(())
    }
}
