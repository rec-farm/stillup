use crate::{error::ApiError, monitoring, notifications, server::AppState};
use std::time::{Duration, Instant};
use tokio::{
    sync::watch,
    task::{JoinError, JoinSet},
};

pub async fn cleanup(state: &AppState) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM runs WHERE checked_at<now()-($1::integer * interval '1 day')")
        .bind(state.config.run_retention_days)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM probe_rounds WHERE finished_at IS NOT NULL AND created_at<now()-($1::integer * interval '1 day')").bind(state.config.run_retention_days).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM check_jobs WHERE status IN ('completed','failed') AND finished_at<now()-interval '1 day'").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
async fn scheduler(state: &AppState) -> Result<(), ApiError> {
    monitoring::enqueue(state, None).await?;
    notifications::reminders(state).await?;
    sqlx::query("INSERT INTO worker_health(id,seen_at) VALUES('primary',now()) ON CONFLICT(id) DO UPDATE SET seen_at=now()").execute(&state.pool).await?;
    Ok(())
}
#[derive(Clone, Copy)]
enum Task {
    Scheduler,
    Check,
    Notification,
}
async fn task(state: AppState, mut stop: watch::Receiver<bool>, kind: Task) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_cleanup = None;
    loop {
        if *stop.borrow() {
            break;
        }
        tokio::select! {
            changed = stop.changed() => {if changed.is_err() || *stop.borrow() {break;} continue;}
            _ = interval.tick() => {}
        }
        if *stop.borrow() {
            break;
        }
        let result = match kind {
            Task::Scheduler => scheduler(&state).await,
            Task::Check => monitoring::run_one(&state).await.map(|_| ()),
            Task::Notification => notifications::deliver_one(&state, None).await.map(|_| ()),
        };
        if result.is_err() {
            tracing::error!("Worker cycle could not complete; durable leases will recover");
        }
        if matches!(kind, Task::Scheduler)
            && last_cleanup.is_none_or(|last: Instant| last.elapsed() >= Duration::from_secs(3600))
        {
            if cleanup(&state).await.is_ok() {
                last_cleanup = Some(Instant::now());
            } else {
                tracing::error!("Worker retention cleanup could not complete");
            }
        }
    }
}
/// Stop scheduling on shutdown, then await each bounded in-flight HTTP operation.
pub async fn run(state: AppState, stop: watch::Receiver<bool>) -> Result<(), JoinError> {
    let mut tasks = JoinSet::new();
    tasks.spawn(task(state.clone(), stop.clone(), Task::Scheduler));
    for _ in 0..5 {
        tasks.spawn(task(state.clone(), stop.clone(), Task::Check));
        tasks.spawn(task(state.clone(), stop.clone(), Task::Notification));
    }
    while let Some(result) = tasks.join_next().await {
        result?;
    }
    Ok(())
}
