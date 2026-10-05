use sqlx::postgres::PgPoolOptions;
use stillup_api::{
    config::Config,
    database,
    server::{AppState, router},
};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "stillup_api=info".into()))
        .init();
    let config = Config::from_env().map_err(std::io::Error::other)?;
    let pool = PgPoolOptions::new()
        .max_connections(15)
        .connect(&config.database_url)
        .await?;
    database::migrate(&pool).await?;
    if std::env::args().nth(1).as_deref() == Some("migrate") {
        pool.close().await;
        return Ok(());
    }
    stillup_api::notifications::initialize(&pool, &config.alert_webhook_url).await?;
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(address = %listener.local_addr()?, "StillUp Rust API listening");
    axum::serve(
        listener,
        router(AppState::new(pool.clone(), config))
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    pool.close().await;
    Ok(())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("signal handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => (), _ = terminate.recv() => () }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await.expect("signal handler");
    }
}
