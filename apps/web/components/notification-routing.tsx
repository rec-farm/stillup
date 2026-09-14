'use client';
import { useEffect, useState } from 'react';
import type { Channel, CheckConfig } from '@stillup/core';
export function NotificationRouting({ config }: { config?: CheckConfig }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState('');
  const [mode, setMode] = useState(
    config?.notificationChannelIds === undefined
      ? 'default'
      : config.notificationChannelIds.length
        ? 'selected'
        : 'none',
  );
  const [selected, setSelected] = useState(config?.notificationChannelIds ?? []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/v1/notification-channels', { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('Could not load channels. Existing routing is preserved.');
        setChannels(await r.json());
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <section className="notification-routing">
      <h3>Notifications</h3>
      <label htmlFor="notification-routing">Send incident and recovery alerts to</label>
      <select
        id="notification-routing"
        name="notificationRouting"
        value={mode}
        onChange={(e) => setMode(e.target.value)}
      >
        <option value="default">Default channels</option>
        <option value="selected">Selected channels</option>
        <option value="none">No channels (mute this check)</option>
      </select>
      {error && <p className="error-message">{error}</p>}
      {mode === 'selected' && (
        <div>
          {selected.map((id) => (
            <input type="hidden" key={id} name="notificationChannelId" value={id} />
          ))}
          {channels.map((c) => (
            <label className="checkbox-label" key={c.id}>
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={(e) =>
                  setSelected((ids) =>
                    e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id),
                  )
                }
              />
              {c.name}
              {c.enabled ? '' : ' (disabled)'}
            </label>
          ))}
          {!channels.length && (
            <p className="field-hint">
              Create channels using Manage notifications on the dashboard.
            </p>
          )}
          {!selected.length && (
            <p className="field-hint">No selected channels means this check is muted.</p>
          )}
        </div>
      )}
      <label htmlFor="reminder-interval">Outage reminder interval (seconds, optional)</label>
      <input
        id="reminder-interval"
        name="reminderIntervalSeconds"
        type="number"
        min={300}
        max={86400}
        step={1}
        defaultValue={config?.reminderIntervalSeconds ?? ''}
        placeholder="Off by default"
      />
      <p className="field-hint">
        Leave empty for incident and recovery events only. Reminders require recent failed
        observations and stop while paused, archived, recovering, or stale. Minimum 300 seconds.
      </p>
    </section>
  );
}
