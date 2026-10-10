use sqlx::PgPool;

pub fn pool_options(max_connections: u32) -> sqlx::postgres::PgPoolOptions {
    use sqlx::Connection;
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_connections)
        .test_before_acquire(false)
        .before_acquire(|connection, metadata| {
            Box::pin(async move {
                // Validate idle connections while avoiding an extra database round trip
                // for each query during an active request burst.
                if metadata.idle_for >= std::time::Duration::from_secs(1) {
                    connection.ping().await?;
                }
                Ok(true)
            })
        })
}

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001_initial.sql",
        include_str!("../../packages/db/migrations/001_initial.sql"),
    ),
    (
        "002_check_revisions.sql",
        include_str!("../../packages/db/migrations/002_check_revisions.sql"),
    ),
    (
        "003_assertion_results.sql",
        include_str!("../../packages/db/migrations/003_assertion_results.sql"),
    ),
    (
        "004_notifications.sql",
        include_str!("../../packages/db/migrations/004_notifications.sql"),
    ),
    (
        "005_secrets_and_status.sql",
        include_str!("../../packages/db/migrations/005_secrets_and_status.sql"),
    ),
    (
        "006_probes.sql",
        include_str!("../../packages/db/migrations/006_probes.sql"),
    ),
    (
        "007_monitoring_as_code.sql",
        include_str!("../../packages/db/migrations/007_monitoring_as_code.sql"),
    ),
    (
        "007_workspace_appearance.sql",
        include_str!("../../packages/db/migrations/007_workspace_appearance.sql"),
    ),
    (
        "008_rust_check_jobs.sql",
        include_str!("../../packages/db/migrations/008_rust_check_jobs.sql"),
    ),
    (
        "009_uptime_rollups.sql",
        include_str!("../../packages/db/migrations/009_uptime_rollups.sql"),
    ),
    (
        "010_users.sql",
        include_str!("../../packages/db/migrations/010_users.sql"),
    ),
    (
        "011_backchannel_logout.sql",
        include_str!("../../packages/db/migrations/011_backchannel_logout.sql"),
    ),
];

// Reuse the deployed migration ledger and lock. Two 007 migrations exist; their full
// filenames are identities, so a numeric SQLx migration ledger would be incompatible.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(782314)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS stillup_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())").execute(&mut *tx).await?;
    for (name, sql) in MIGRATIONS {
        let exists = sqlx::query("SELECT name FROM stillup_migrations WHERE name=$1")
            .bind(name)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
        if exists {
            continue;
        }
        sqlx::raw_sql(sql).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO stillup_migrations(name) VALUES ($1)")
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_manifest_matches_existing_ledger_and_covers_checkout() {
        let directory =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/db/migrations");
        let mut files: Vec<_> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".sql"))
            .collect();
        files.sort();
        assert_eq!(
            files,
            MIGRATIONS
                .iter()
                .map(|(name, _)| name.to_string())
                .collect::<Vec<_>>()
        );
    }
}
