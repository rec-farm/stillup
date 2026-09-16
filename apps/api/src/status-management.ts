import { connectDatabase } from '@stillup/db';
import {
  statusSettingsSchema,
  maintenanceSchema,
  manualIncidentSchema,
  statusUpdateSchema,
  type StatusManagement,
  type PublicStatus,
  type CommunicationIncident,
  type Maintenance,
} from '@stillup/core';
import { env } from './env';
import { CheckError } from './errors';
type Pool = ReturnType<typeof connectDatabase>['pool'];
const date = (v: Date | null) => v?.toISOString() ?? null;
const windowRow = (r: Record<string, any>): Maintenance => ({
  id: r.id,
  title: r.title,
  description: r.description,
  monitorIds: r.monitor_ids,
  startsAt: date(r.starts_at)!,
  endsAt: date(r.ends_at)!,
  cancelled: r.cancelled,
  revision: r.revision,
});
export function createStatusManagement(pool: Pool) {
  async function settings() {
    const row = (await pool.query('SELECT * FROM status_settings WHERE id=1')).rows[0];
    return {
      settings: row
        ? statusSettingsSchema.parse(row.config)
        : statusSettingsSchema.parse({ title: env.STATUS_PAGE_TITLE }),
      revision: row?.revision ?? 0,
    };
  }
  async function validMonitors(ids: string[], published = false) {
    if (!ids.length) return;
    const rows = await pool.query(
      "SELECT id FROM monitors WHERE id=ANY($1::uuid[]) AND (NOT $2 OR (config->>'public')::boolean AND archived_at IS NULL)",
      [ids, published],
    );
    if (rows.rowCount !== new Set(ids).size)
      throw new CheckError(
        400,
        published ? 'Select published, active components' : 'A component does not exist',
      );
  }
  async function saveSettings(config: unknown, revision: number) {
    const parsed = statusSettingsSchema.parse(config);
    await validMonitors(parsed.groups.flatMap((g) => g.monitorIds));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stillup-status-settings'))");
      const row = (await client.query('SELECT revision FROM status_settings WHERE id=1')).rows[0];
      if ((row?.revision ?? 0) !== revision)
        throw new CheckError(409, 'Public page settings changed elsewhere. Reload before saving.');
      await client.query(
        'INSERT INTO status_settings(id,config,revision) VALUES(1,$1,1) ON CONFLICT(id) DO UPDATE SET config=$1,revision=status_settings.revision+1',
        [JSON.stringify(parsed)],
      );
      await client.query('COMMIT');
      return settings();
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async function saveMaintenance(input: unknown, id?: string, revision?: number) {
    const v = maintenanceSchema.parse(input);
    await validMonitors(v.monitorIds, !id);
    const params = [v.title, v.description, v.monitorIds, v.startsAt, v.endsAt, v.cancelled];
    if (id) {
      const result = await pool.query(
        'UPDATE maintenance_windows SET title=$1,description=$2,monitor_ids=$3,starts_at=$4,ends_at=$5,cancelled=$6,revision=revision+1 WHERE id=$7 AND revision=$8 RETURNING *',
        [...params, id, revision],
      );
      if (!result.rowCount)
        throw new CheckError(
          409,
          'Maintenance changed elsewhere or was removed. Reload before saving.',
        );
      return windowRow(result.rows[0]);
    }
    return windowRow(
      (
        await pool.query(
          'INSERT INTO maintenance_windows(title,description,monitor_ids,starts_at,ends_at,cancelled) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          params,
        )
      ).rows[0],
    );
  }
  async function createIncident(input: unknown) {
    const v = manualIncidentSchema.parse(input);
    await validMonitors(v.monitorIds, true);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (
        await client.query(
          'INSERT INTO status_incidents(title,monitor_ids) VALUES($1,$2) RETURNING id',
          [v.title, v.monitorIds],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO status_updates(incident_id,source,stage,body) VALUES($1,'manual','investigating',$2)",
        [row.id, v.body],
      );
      await client.query('COMMIT');
      return { id: row.id };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async function updateIncident(id: string, input: unknown) {
    const v = statusUpdateSchema.parse(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const table = v.source === 'manual' ? 'status_incidents' : 'incidents';
      const revision = v.source === 'manual' ? 'revision' : 'communication_revision';
      const row = (await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id]))
        .rows[0];
      if (!row) throw new CheckError(404, 'Incident not found');
      if (row[revision] !== v.expectedRevision)
        throw new CheckError(409, 'Incident was updated elsewhere. Reload before publishing.');
      if (v.source === 'automatic' && v.stage === 'resolved' && !row.resolved_at)
        throw new CheckError(
          409,
          'Monitoring has not confirmed recovery. Use a monitoring update instead.',
        );
      if (v.source === 'manual')
        await client.query(
          'UPDATE status_incidents SET revision=revision+1,resolved_at=CASE WHEN $2 THEN COALESCE(resolved_at,now()) ELSE NULL END WHERE id=$1',
          [id, v.stage === 'resolved'],
        );
      else
        await client.query(
          'UPDATE incidents SET communication_revision=communication_revision+1 WHERE id=$1',
          [id],
        );
      await client.query(
        'INSERT INTO status_updates(incident_id,source,stage,body) VALUES($1,$2,$3,$4)',
        [id, v.source, v.stage, v.body],
      );
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async function communications(publicIds?: string[]): Promise<CommunicationIncident[]> {
    const result = await pool.query(
      `SELECT * FROM (SELECT id,name,ARRAY[monitor_id] AS monitor_ids,'automatic' AS source,opened_at,resolved_at,communication_revision AS revision FROM incidents WHERE ($1::uuid[] IS NULL OR monitor_id=ANY($1::uuid[])) UNION ALL SELECT id,title AS name,monitor_ids,'manual' AS source,created_at AS opened_at,resolved_at,revision FROM status_incidents WHERE ($1::uuid[] IS NULL OR monitor_ids && $1::uuid[])  ) combined ORDER BY (resolved_at IS NULL) DESC,opened_at DESC LIMIT 100`,
      [publicIds ?? null],
    );
    const updates = (
      await pool.query(
        'SELECT * FROM (SELECT *,row_number() OVER (PARTITION BY incident_id ORDER BY created_at DESC,id DESC) AS rn FROM status_updates WHERE incident_id=ANY($1::uuid[])) t WHERE rn<=50 ORDER BY created_at DESC,id DESC',
        [result.rows.map((r) => r.id)],
      )
    ).rows;
    return result.rows.map((r) => {
      const history = updates
        .filter((u) => u.incident_id === r.id && u.source === r.source)
        .map((u) => ({ id: u.id, stage: u.stage, body: u.body, createdAt: date(u.created_at)! }));
      return {
        id: r.id,
        name: r.name,
        source: r.source,
        monitorIds: publicIds
          ? r.monitor_ids.filter((id: string) => publicIds.includes(id))
          : r.monitor_ids,
        openedAt: date(r.opened_at)!,
        resolvedAt: date(r.resolved_at),
        revision: r.revision,
        stage: r.resolved_at ? 'resolved' : (history[0]?.stage ?? 'investigating'),
        updates: history,
      };
    });
  }
  async function admin(): Promise<StatusManagement> {
    const [config, maintenance, incidents] = await Promise.all([
      settings(),
      pool.query(
        'SELECT * FROM maintenance_windows ORDER BY (NOT cancelled AND starts_at<=now() AND ends_at>now()) DESC,starts_at DESC LIMIT 100',
      ),
      communications(),
    ]);
    return { ...config, maintenance: maintenance.rows.map(windowRow), incidents };
  }
  async function decorate(base: PublicStatus): Promise<PublicStatus> {
    const ids = base.components.map((c) => c.id);
    const [{ settings: config }, windows, incidents, impact] = await Promise.all([
      settings(),
      pool.query(
        'SELECT * FROM maintenance_windows WHERE NOT cancelled AND ends_at>now() AND (cardinality(monitor_ids)=0 OR monitor_ids && $1::uuid[]) ORDER BY starts_at LIMIT 100',
        [ids],
      ),
      communications(ids),
      pool.query(
        `SELECT m.id,
        EXISTS(SELECT 1 FROM maintenance_windows w WHERE NOT w.cancelled AND w.starts_at<=now() AND w.ends_at>now() AND (cardinality(w.monitor_ids)=0 OR m.id=ANY(w.monitor_ids))) AS maintenance,
        EXISTS(SELECT 1 FROM status_incidents i WHERE i.resolved_at IS NULL AND m.id=ANY(i.monitor_ids)) AS incident
        FROM monitors m WHERE m.id=ANY($1::uuid[])`,
        [ids],
      ),
    ]);
    const maintenance = ids.length
      ? windows.rows.map(windowRow).map((w) => ({
          ...w,
          monitorIds: w.monitorIds.length ? w.monitorIds.filter((id) => ids.includes(id)) : ids,
        }))
      : [];
    const active = new Set(impact.rows.filter((r) => r.maintenance).map((r) => r.id));
    const affected = new Set(impact.rows.filter((r) => r.incident).map((r) => r.id));
    const components = base.components.map((c) => ({
      ...c,
      groupId: config.groups.find((g) => g.monitorIds.includes(c.id))?.id,
      health: active.has(c.id)
        ? ('maintenance' as const)
        : affected.has(c.id)
          ? ('down' as const)
          : c.health,
    }));
    const { groups, ...branding } = config;
    return {
      ...base,
      title: config.title,
      branding,
      groups: groups
        .filter((g) => components.some((c) => c.groupId === g.id))
        .map((g) => ({ id: g.id, name: g.name })),
      components,
      maintenance,
      communications: incidents,
    };
  }
  return { admin, saveSettings, saveMaintenance, createIncident, updateIncident, decorate };
}
