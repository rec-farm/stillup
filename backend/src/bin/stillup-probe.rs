#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("stillup_api=info")
        .init();
    let options = stillup_api::probe_runner::Options::from_env().map_err(std::io::Error::other)?;
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let running = stillup_api::probe_runner::run(options, stopped);
    tokio::pin!(running);
    let result = tokio::select! {
        result=&mut running=>result,
        _=shutdown()=>{stop.send(true).ok();running.await}
    };
    result.map_err(|message| std::io::Error::other(message).into())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("signal handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await.ok();
    }
}
