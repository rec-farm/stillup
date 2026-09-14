'use client';
import { useEffect, useState } from 'react';
import { Activity, ShieldCheck } from 'lucide-react';
import type { PublicStatus } from '@stillup/core';
import { Brand } from './brand';
export function StatusView({ initial }: { initial: PublicStatus }) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let active = true;
    const timer = setInterval(async () => {
      try {
        const response = await fetch('/api/v1/public/status');
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (active) {
          setData(next);
          setStale(false);
        }
      } catch {
        if (active) setStale(true);
      }
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const down = data.components.some((c) => c.health === 'down');
  const unknown =
    stale ||
    !data.components.length ||
    data.components.some((c) => ['unknown', 'paused'].includes(c.health));
  const summary = stale
    ? 'Status updates are delayed'
    : down
      ? 'Some services are experiencing issues'
      : unknown
        ? 'Waiting for service observations'
        : 'All systems operational';
  const labels = {
    up: 'Operational',
    down: 'Service disruption',
    unknown: 'Awaiting data',
    paused: 'Monitoring paused',
    archived: 'Archived',
  };
  return (
    <main className="status-page">
      <header>
        <Brand />
        <span className="status-caption">SERVICE STATUS</span>
      </header>
      <section
        className={`status-hero ${stale ? 'unknown' : down ? 'down' : unknown ? 'unknown' : 'up'}`}
      >
        <div className="status-symbol">
          {unknown || down ? <Activity size={30} /> : <ShieldCheck size={30} />}
        </div>
        <span className="eyebrow">{data.title}</span>
        <h1>{summary}</h1>
        <p>
          {stale
            ? 'The last known status is shown below. Fresh observations are currently unavailable.'
            : down
              ? 'We’re tracking the affected services below.'
              : 'A live look at the services you depend on.'}
        </p>
        <small>
          Updated {new Date(data.updatedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC ·
          Refreshes every 15s
        </small>
      </section>
      <section className="status-components">
        <h2>Services</h2>
        {data.components.length ? (
          data.components.map((c) => (
            <div className="public-component" key={c.id}>
              <strong>{c.name}</strong>
              <span className={`public-health ${stale ? 'unknown' : c.health}`}>
                <span />
                {stale ? 'Status unavailable' : labels[c.health]}
              </span>
            </div>
          ))
        ) : (
          <div className="public-empty">No services have been published yet.</div>
        )}
      </section>
      <section className="public-incidents">
        <h2>Incident history</h2>
        {data.incidents.length ? (
          data.incidents.map((i) => (
            <article key={i.id}>
              <span className={`incident-state ${i.resolvedAt ? 'resolved' : ''}`}>
                {i.resolvedAt ? 'Resolved' : 'Investigating'}
              </span>
              <h3>{i.name}</h3>
              <p>Detected {new Date(i.openedAt).toLocaleString('en-GB', { timeZone: 'UTC' })}</p>
              {i.resolvedAt && (
                <p>
                  Recovered {new Date(i.resolvedAt).toLocaleString('en-GB', { timeZone: 'UTC' })}
                </p>
              )}
            </article>
          ))
        ) : (
          <div className="public-empty">
            <ShieldCheck size={20} />
            No incidents reported.
          </div>
        )}
      </section>
      <footer>
        Powered by <a href="/">StillUp</a>
        <span>Know before your users do.</span>
      </footer>
    </main>
  );
}
