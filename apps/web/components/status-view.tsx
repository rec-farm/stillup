'use client';
import { useEffect, useState, type CSSProperties } from 'react';
import Image from 'next/image';
import { Activity, ShieldCheck } from 'lucide-react';
import type { PublicStatus } from '@stillup/core';
import { Brand } from './brand';
const date = (value: string) =>
  new Date(value).toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC';
export function StatusView({
  initial,
  preview = false,
}: {
  initial: PublicStatus;
  preview?: boolean;
}) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
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
  const identity =
    brand && (brand.logoUrl || brand.brandName !== 'StillUp') ? (
      <span className="public-brand">
        {brand.logoUrl && <Image unoptimized src={brand.logoUrl} width={40} height={40} alt="" />}
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
    <div
      className="status-canvas"
      data-theme={brand?.theme ?? 'light'}
      style={
        {
          '--status-accent': brand?.accentColor ?? '#00856a',
          '--status-background': brand?.backgroundColor ?? '#f6f8f7',
          '--status-surface': brand?.surfaceColor ?? '#ffffff',
          '--status-text': brand?.textColor ?? '#243d35',
          '--status-radius': `${brand?.cornerRadius ?? 16}px`,
        } as CSSProperties
      }
    >
      <main
        className="status-page"
        data-layout={brand?.layout ?? 'comfortable'}
        data-font={brand?.font ?? 'sans'}
        style={{ '--status-accent': brand?.accentColor ?? '#00856a' } as CSSProperties}
      >
        <header>
          {brand?.homepageUrl ? (
            <a href={brand.homepageUrl} className="public-brand-link">
              {identity}
            </a>
          ) : (
            identity
          )}
          <span className="status-caption">{brand?.headerLabel ?? 'SERVICE STATUS'}</span>
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
        <section
          className={`status-hero ${stale ? 'unknown' : down ? 'down' : maintenance ? 'maintenance' : unknown ? 'unknown' : 'up'}`}
        >
          <div className="status-symbol">
            {unknown || down || maintenance ? <Activity size={30} /> : <ShieldCheck size={30} />}
          </div>
          <span className="eyebrow">{data.title}</span>
          <h1>{summary}</h1>
          <p>
            {stale
              ? 'The last known status is shown below. Fresh observations are currently unavailable.'
              : down
                ? 'We’re tracking the affected services below.'
                : (brand?.description ?? 'A live look at the services you depend on.')}
          </p>
          <small>
            Updated {new Date(data.updatedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC
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
                <span className="incident-state">
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
                <ShieldCheck size={20} />
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
        <footer>
          {brand?.showPoweredBy !== false && (
            <span className="status-attribution">Powered by StillUp</span>
          )}
          <span>{brand?.footerText ?? 'Know before your users do.'}</span>
        </footer>
      </main>
    </div>
  );
}
