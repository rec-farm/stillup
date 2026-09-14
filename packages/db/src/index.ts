import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  pgTable,
  uuid,
  jsonb,
  boolean,
  timestamp,
  text,
  integer,
  index,
  primaryKey,
  foreignKey,
} from 'drizzle-orm/pg-core';
import type { CheckConfig, CheckResult } from '@stillup/core';
export const monitors = pgTable(
  'monitors',
  {
    id: uuid().primaryKey().defaultRandom(),
    config: jsonb().$type<CheckConfig>().notNull(),
    configRevision: integer().notNull().default(1),
    executionEpoch: integer().notNull().default(1),
    archivedAt: timestamp({ withTimezone: true, mode: 'string' }),
    enabled: boolean().notNull().default(true),
    status: text().$type<'up' | 'down' | 'unknown'>().notNull().default('unknown'),
    failures: integer().notNull().default(0),
    successes: integer().notNull().default(0),
    nextRunAt: timestamp({ withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    lastRunAt: timestamp({ withTimezone: true, mode: 'string' }),
    lastObservedAt: timestamp({ withTimezone: true, mode: 'string' }),
    lastDurationMs: integer(),
    lastOutcome: text().$type<CheckResult['outcome']>(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('monitors_due_idx').on(t.nextRunAt)],
);
export const checkRevisions = pgTable(
  'check_revisions',
  {
    monitorId: uuid()
      .notNull()
      .references(() => monitors.id),
    revision: integer().notNull(),
    config: jsonb().$type<CheckConfig>().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.revision] })],
);
export const runs = pgTable(
  'runs',
  {
    id: uuid().primaryKey(),
    monitorId: uuid()
      .notNull()
      .references(() => monitors.id),
    configRevision: integer().notNull().default(1),
    outcome: text().$type<CheckResult['outcome']>().notNull(),
    statusCode: integer(),
    durationMs: integer().notNull(),
    failures: jsonb().$type<string[]>().notNull(),
    assertions: jsonb().$type<NonNullable<CheckResult['assertions']>>().notNull().default([]),
    checkedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [
    index('runs_monitor_time_idx').on(t.monitorId, t.checkedAt),
    foreignKey({
      columns: [t.monitorId, t.configRevision],
      foreignColumns: [checkRevisions.monitorId, checkRevisions.revision],
    }),
  ],
);
export const incidents = pgTable('incidents', {
  id: uuid().primaryKey().defaultRandom(),
  monitorId: uuid()
    .notNull()
    .references(() => monitors.id),
  name: text().notNull(),
  openedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  resolvedAt: timestamp({ withTimezone: true, mode: 'string' }),
});
export function connectDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 15 });
  return {
    pool,
    db: drizzle(pool, {
      schema: { monitors, runs, incidents, checkRevisions },
      casing: 'snake_case',
    }),
  };
}
export { eq, desc, and, sql, isNull } from 'drizzle-orm';

export type { PoolClient } from 'pg';
