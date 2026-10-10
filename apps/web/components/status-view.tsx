'use client';
import { useEffect, useState, type CSSProperties } from 'react';
import { CircleHelp, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react';
import {
  customizedColor,
  formatUptime,
  statusDesignDefaults,
  type PublicStatus,
  type Uptime,
} from '@stillup/core';
import { Brand } from './brand';
const date = (value: string) => (
  <time dateTime={value}>{new Date(value).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</time>
);
const uptimeLevel = (percentage: number | null | undefined) =>
  percentage == null ? 'none' : percentage >= 99.9 ? 'up' : percentage >= 95 ? 'degraded' : 'down';
export function UptimeBars({ uptime, now }: { uptime: Uptime; now: string }) {
  const byDate = new Map(uptime.days.map((d) => [d.date, d.percentage]));
  const today = Date.parse(now.slice(0, 10));
  const days = Array.from({ length: uptime.windowDays }, (_, index) => {
    const date = new Date(today - (uptime.windowDays - 1 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return { date, percentage: byDate.get(date) };
  });
  const summary =
    uptime.percentage == null ? 'No data yet' : `${formatUptime(uptime.percentage)} uptime`;
  return (
    <div className="public-uptime">
      <div
        className="public-uptime-bars"
        role="img"
        aria-label={`${summary} over the last ${uptime.windowDays} days`}
      >
        {days.map((d) => (
          <span
            key={d.date}
            className={uptimeLevel(d.percentage)}
            title={`${d.date}: ${d.percentage == null ? 'No data' : formatUptime(d.percentage)}`}
          />
        ))}
      </div>
      <div className="public-uptime-caption" aria-hidden="true">
        <span className="wide">{uptime.windowDays} days ago</span>
        <span className="narrow">30 days ago</span>
        <span>
          {summary} · {uptime.windowDays} days
        </span>
        <span>Today</span>
      </div>
    </div>
  );
}
const muted = (color: string | undefined) =>
  color && `color-mix(in oklab, ${color} 74%, transparent)`;
export function StatusView({
  initial,
  preview = false,
  previewTheme,
}: {
  initial: PublicStatus;
  preview?: boolean;
  /** Forces one side of an 'auto' theme in the editor preview. */
  previewTheme?: 'light' | 'dark';
}) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
  const [failedLogo, setFailedLogo] = useState('');
  useEffect(() => {
    if (preview) {
      setData(initial);
      return;
    }
    let active = true;
    let pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch('/api/v1/public/status', {
          credentials: 'omit',
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (active) {
          setData(next);
          setStale(false);
        }
      } catch {
        if (active) setStale(true);
      } finally {
        pending = false;
      }
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [initial, preview]);
  const down = data.components.some((c) => c.health === 'down');
  const maintenance = data.components.some((c) => c.health === 'maintenance');
  const unknown =
    stale ||
    !data.components.length ||
    data.components.some((c) => ['unknown', 'paused'].includes(c.health));
  const summary = stale
    ? 'Status updates are delayed'
    : down
      ? 'Some services are experiencing issues'
      : maintenance
        ? 'Scheduled maintenance in progress'
        : unknown
          ? 'Waiting for service observations'
          : 'All systems operational';
  const labels = {
    up: 'Operational',
    down: 'Service disruption',
    unknown: 'Awaiting data',
    paused: 'Monitoring paused',
    archived: 'Archived',
    maintenance: 'Under maintenance',
  };
  const groups = [
    ...(data.groups ?? []),
    { id: '', name: data.groups?.length ? 'Other services' : 'Services' },
  ];
  const brand = data.branding;
  const textColor = customizedColor(brand?.textColor, statusDesignDefaults.textColor);
  const darkTextColor = brand?.darkTextColor || undefined;
  const canvasStyle = {
    '--status-accent': customizedColor(brand?.accentColor, statusDesignDefaults.accentColor),
    '--status-background': customizedColor(
      brand?.backgroundColor,
      statusDesignDefaults.backgroundColor,
    ),
    '--status-surface': customizedColor(brand?.surfaceColor, statusDesignDefaults.surfaceColor),
    '--status-text': textColor,
    '--status-text-muted': muted(textColor),
    '--status-dark-background': brand?.darkBackgroundColor || undefined,
    '--status-dark-surface': brand?.darkSurfaceColor || undefined,
    '--status-dark-text': darkTextColor,
    '--status-dark-text-muted': muted(darkTextColor),
    '--status-radius':
      brand?.cornerRadius !== undefined && brand.cornerRadius !== statusDesignDefaults.cornerRadius
        ? `${brand.cornerRadius}px`
        : undefined,
  } as CSSProperties;
  const theme = brand?.theme === 'auto' && previewTheme ? previewTheme : (brand?.theme ?? 'light');
  const logo = brand?.logoUrl && brand.logoUrl !== failedLogo ? brand.logoUrl : '';
  const state = stale
    ? 'unknown'
    : down
      ? 'down'
      : maintenance
        ? 'maintenance'
        : unknown
          ? 'unknown'
          : 'up';
  const StateIcon = {
    up: ShieldCheck,
    down: TriangleAlert,
    maintenance: Wrench,
    unknown: CircleHelp,
  }[state];
  const identity =
    brand && (brand.logoUrl || brand.brandName !== 'StillUp') ? (
      <span className="public-brand">
        {logo && (
          <img src={logo} width={40} height={40} alt="" onError={() => setFailedLogo(logo)} />
        )}
        {brand.brandName}
      </span>
    ) : (
      <Brand />
    );
  const content = (position: 'before-services' | 'after-services') =>
    brand?.content
      ?.filter((block) => block.position === position)
      .map((block) => (
        <section className="status-content-block" key={block.id}>
          <h2>{block.title}</h2>
          <p className="public-prose">{block.body}</p>
        </section>
      ));
  return (
    <div className="status-canvas" data-theme={theme} data-product="stillup" style={canvasStyle}>
      <main
        className="status-page"
        data-layout={brand?.layout ?? 'comfortable'}
        data-font={brand?.font ?? 'sans'}
      >
        <header>
          {brand?.homepageUrl ? (
            <a href={brand.homepageUrl} className="public-brand-link">
              {identity}
            </a>
          ) : (
            identity
          )}
          {(brand?.headerLabel ?? 'SERVICE STATUS') && (
            <span className="status-caption label-stamp">
              {brand?.headerLabel ?? 'SERVICE STATUS'}
            </span>
          )}
        </header>
        {!!brand?.links?.length && (
          <nav className="status-links" aria-label="Helpful links">
            {brand.links.map((link, index) => (
              <a key={index} href={link.url}>
                {link.label}
              </a>
            ))}
          </nav>
        )}
        <section className={`status-hero ${state}`}>
          <div className="status-symbol">
            <StateIcon size={24} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <span className="eyebrow">{data.title}</span>
          <h1>
            {summary}
            <span className="period">.</span>
          </h1>
          {(stale || down || brand?.description !== '') && (
            <p>
              {stale
                ? 'The last known status is shown below. Fresh observations are currently unavailable.'
                : down
                  ? 'We’re tracking the affected services below.'
                  : (brand?.description ?? 'A live look at the services you depend on.')}
            </p>
          )}
          <small>
            Updated{' '}
            <time dateTime={data.updatedAt}>
              {new Date(data.updatedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC
            </time>{' '}
            · {preview ? 'Preview snapshot' : 'Refreshes every 15s'}
          </small>
        </section>
        {content('before-services')}
        {groups.map((g) => {
          const components = data.components.filter((c) => (c.groupId ?? '') === g.id);
          return components.length ? (
            <section className="status-components" key={g.id}>
              <h2>{g.name}</h2>
              {components.map((c) => (
                <div className="public-component" key={c.id}>
                  <strong>{c.name}</strong>
                  <span className={`public-health ${stale ? 'unknown' : c.health}`}>
                    <span />
                    {stale ? 'Status unavailable' : labels[c.health]}
                  </span>
                  {c.uptime && <UptimeBars uptime={c.uptime} now={data.updatedAt} />}
                </div>
              ))}
            </section>
          ) : null;
        })}
        {!data.components.length && (
          <div className="public-empty">No services have been published yet.</div>
        )}
        {content('after-services')}
        {!!data.maintenance?.length && (
          <section className="public-incidents">
            <h2>Maintenance</h2>
            {data.maintenance.map((w) => (
              <article key={w.id}>
                <span className="incident-state maintenance">
                  {stale
                    ? 'Schedule (last known)'
                    : Date.parse(w.endsAt) <= Date.now()
                      ? 'Window ended'
                      : Date.parse(w.startsAt) <= Date.now()
                        ? 'In progress'
                        : 'Scheduled'}
                </span>
                <h3>{w.title}</h3>
                <p>
                  {date(w.startsAt)} – {date(w.endsAt)}
                </p>
                <p className="public-prose">{w.description}</p>
                <small>
                  Affected:{' '}
                  {data.components
                    .filter((c) => w.monitorIds.includes(c.id))
                    .map((c) => c.name)
                    .join(', ')}
                </small>
              </article>
            ))}
          </section>
        )}
        <section className="public-incidents">
          <h2>{brand?.showIncidentHistory === false ? 'Active incidents' : 'Incident history'}</h2>
          {data.communications ? (
            data.communications.filter((i) => brand?.showIncidentHistory !== false || !i.resolvedAt)
              .length ? (
              data.communications
                .filter((i) => brand?.showIncidentHistory !== false || !i.resolvedAt)
                .map((i) => (
                  <article key={`${i.source}:${i.id}`}>
                    <span className={`incident-state ${i.resolvedAt ? 'resolved' : ''}`}>
                      {i.stage}
                    </span>
                    <h3>{i.name}</h3>
                    <p>Opened {date(i.openedAt)}</p>
                    {i.resolvedAt && <p>Recovered {date(i.resolvedAt)}</p>}
                    {i.updates.map((u) => (
                      <div className="public-update" key={u.id}>
                        <strong>{u.stage}</strong>
                        <small>{date(u.createdAt)}</small>
                        <p className="public-prose">{u.body}</p>
                      </div>
                    ))}
                  </article>
                ))
            ) : (
              <div className="public-empty">
                <ShieldCheck size={20} strokeWidth={1.5} aria-hidden="true" />
                No incidents reported.
              </div>
            )
          ) : (
            data.incidents
              .filter((i) => brand?.showIncidentHistory !== false || !i.resolvedAt)
              .map((i) => (
                <article key={i.id}>
                  <h3>{i.name}</h3>
                  <p>
                    {i.resolvedAt ? 'Resolved' : 'Investigating'} · {date(i.openedAt)}
                  </p>
                </article>
              ))
          )}
        </section>
        {(brand?.showPoweredBy !== false || brand?.footerText !== '') && (
          <footer>
            {brand?.showPoweredBy !== false && (
              <span className="status-attribution">
                <span className="eyebrow">Powered by</span>
                {(['cream', 'ink'] as const).map((tone) => (
                  <img
                    key={tone}
                    className={`status-endorsed status-endorsed-${tone}`}
                    src={`/brand/stillup-endorsed-${tone}.svg`}
                    width={146}
                    height={53}
                    alt="StillUp by REC"
                  />
                ))}
              </span>
            )}
            {brand?.footerText !== '' && (
              <span>{brand?.footerText ?? 'Know before your users do.'}</span>
            )}
          </footer>
        )}
      </main>
    </div>
  );
}
