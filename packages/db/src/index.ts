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
} from 'drizzle-orm/pg-core';
import type { CheckConfig, CheckResult } from '@stillup/core';
export const monitors = pgTable(
  'monitors',
  {
    id: uuid().primaryKey().defaultRandom(),
    config: jsonb().$type<CheckConfig>().notNull(),
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
export const runs = pgTable(
  'runs',
  {
    id: uuid().primaryKey(),
    monitorId: uuid()
      .notNull()
      .references(() => monitors.id),
    outcome: text().$type<CheckResult['outcome']>().notNull(),
    statusCode: integer(),
    durationMs: integer().notNull(),
    failures: jsonb().$type<string[]>().notNull(),
    checkedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [index('runs_monitor_time_idx').on(t.monitorId, t.checkedAt)],
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
    db: drizzle(pool, { schema: { monitors, runs, incidents }, casing: 'snake_case' }),
  };
}
export { eq, desc, and, sql, isNull } from 'drizzle-orm';
