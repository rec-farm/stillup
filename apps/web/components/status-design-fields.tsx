import { useState, type ReactNode } from 'react';
import Image from 'next/image';
import { Check, TriangleAlert } from 'lucide-react';
import {
  statusContrastIssues,
  statusDesignDefaults,
  statusPalettes,
  statusPresets,
  type Monitor,
  type StatusPreset,
  type StatusSettings,
} from '@stillup/core';

type Patch = (change: Partial<StatusSettings>) => void;

export const isWebLink = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const presetApplied = (draft: StatusSettings, preset: StatusPreset) =>
  Object.entries(preset.settings).every(
    ([key, value]) =>
      String(draft[key as keyof StatusSettings]).toLowerCase() === String(value).toLowerCase(),
  );

/* The public page caps radius at 6px; 16 is the schema default and renders as 4px. */
const radiusOptions = [
  { value: 0, label: 'Square' },
  { value: 2, label: 'Subtle' },
  { value: statusDesignDefaults.cornerRadius, label: 'Standard' },
  { value: 6, label: 'Rounded' },
];

function Section({
  title,
  hint,
  open = true,
  children,
}: {
  title: string;
  hint?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="status-editor-section" open={open}>
      <summary>
        <h3>{title}</h3>
        {hint && <span>{hint}</span>}
      </summary>
      <div className="status-editor-section-body">{children}</div>
    </details>
  );
}

function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="status-color-field">
      <label htmlFor={id}>{label}</label>
      <div>
        <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <code>{value.toUpperCase()}</code>
      </div>
    </div>
  );
}

function ContrastNote({ draft, theme }: { draft: StatusSettings; theme: 'light' | 'dark' }) {
  const issues = statusContrastIssues({ ...draft, theme });
  if (!issues.length)
    return (
      <p className="status-contrast ok">
        <Check size={14} aria-hidden="true" />
        Text is readable on the page and cards (WCAG AA).
      </p>
    );
  return (
    <div className="status-contrast warn" role="status">
      {issues.map((issue) => (
        <p key={issue.against}>
          <TriangleAlert size={14} aria-hidden="true" />
          Text on the {issue.against === 'background' ? 'page background' : 'cards'} is{' '}
          {issue.ratio.toFixed(1)}:1. Aim for at least 4.5:1 so everyone can read it.
        </p>
      ))}
    </div>
  );
}

function PresetSwatch({ preset }: { preset: StatusPreset }) {
  const palettes = statusPalettes(preset.settings);
  const palette = palettes[preset.settings.theme === 'dark' ? 'dark' : 'light'];
  return (
    <span
      className="status-preset-swatch"
      aria-hidden="true"
      style={{ background: palette.background }}
    >
      <span style={{ background: palette.surface, color: palette.text }}>Aa</span>
      <span style={{ background: preset.settings.accentColor }} />
      {preset.settings.theme === 'auto' && (
        <span className="status-preset-dark" style={{ background: palettes.dark.background }} />
      )}
    </span>
  );
}

function LogoField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [failed, setFailed] = useState('');
  const showable = value && isWebLink(value) && failed !== value;
  return (
    <>
      <label htmlFor="brand-logo">
        Logo URL <span className="optional-label">Optional</span>
      </label>
      <div className="status-logo-field">
        <span className="status-logo-thumb">
          {showable && (
            <Image
              unoptimized
              src={value}
              width={32}
              height={32}
              alt=""
              onError={() => setFailed(value)}
            />
          )}
        </span>
        <input
          id="brand-logo"
          type="url"
          placeholder="https://example.com/logo.svg"
          value={value}
          aria-describedby="brand-logo-hint"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <p id="brand-logo-hint" className="field-hint">
        {value && failed === value
          ? 'That image could not be loaded. Visitors will see your brand name without a logo.'
          : 'A public, square image works best. It also becomes the link preview image.'}
      </p>
    </>
  );
}

export function StatusDesignFields({
  draft,
  patch,
  monitors,
}: {
  draft: StatusSettings;
  patch: Patch;
  monitors: Monitor[];
}) {
  const { links, content, groups } = draft;
  const customDark = !!(draft.darkBackgroundColor || draft.darkSurfaceColor || draft.darkTextColor);
  const darkDefaults = statusPalettes({
    ...draft,
    darkBackgroundColor: '',
    darkSurfaceColor: '',
    darkTextColor: '',
  }).dark;
  const lightPalette = statusPalettes(draft).light;
  const showLight = draft.theme !== 'dark';
  const showDark = draft.theme !== 'light';
  const radius = radiusOptions.some((o) => o.value === draft.cornerRadius)
    ? radiusOptions
    : [...radiusOptions, { value: draft.cornerRadius, label: `Custom (${draft.cornerRadius}px)` }];
  return (
    <>
      <Section title="Start from a preset" hint="Sets theme, colors, type, and corners">
        <div className="status-presets" role="group" aria-label="Presets">
          {statusPresets.map((preset) => {
            const applied = presetApplied(draft, preset);
            return (
              <button
                key={preset.name}
                type="button"
                className="status-preset"
                aria-pressed={applied}
                onClick={() => patch(preset.settings)}
              >
                <PresetSwatch preset={preset} />
                <strong>
                  {preset.name}
                  {applied && <Check size={14} aria-label="Applied" />}
                </strong>
                <small>{preset.description}</small>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Identity" hint="Who visitors see">
        <label htmlFor="status-title">Page title</label>
        <input
          id="status-title"
          required
          maxLength={100}
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
        />
        <label htmlFor="brand-name">Brand name</label>
        <input
          id="brand-name"
          required
          maxLength={80}
          value={draft.brandName}
          onChange={(e) => patch({ brandName: e.target.value })}
        />
        <LogoField value={draft.logoUrl} onChange={(logoUrl) => patch({ logoUrl })} />
        <label htmlFor="status-description">Introduction</label>
        <textarea
          id="status-description"
          maxLength={1000}
          rows={3}
          value={draft.description}
          onChange={(e) => patch({ description: e.target.value })}
        />
        <div className="status-design-grid">
          <div>
            <label htmlFor="brand-home">
              Website URL <span className="optional-label">Optional</span>
            </label>
            <input
              id="brand-home"
              type="url"
              placeholder="https://example.com"
              value={draft.homepageUrl}
              onChange={(e) => patch({ homepageUrl: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="status-favicon">
              Favicon URL <span className="optional-label">Optional</span>
            </label>
            <input
              id="status-favicon"
              type="url"
              placeholder="https://example.com/favicon.png"
              value={draft.faviconUrl}
              onChange={(e) => patch({ faviconUrl: e.target.value })}
            />
          </div>
        </div>
      </Section>

      <Section title="Theme & colors" hint="Contrast is checked as you go">
        <fieldset className="status-theme-choice">
          <legend>Theme</legend>
          {(
            [
              ['light', 'Light'],
              ['dark', 'Dark'],
              ['auto', 'Follow visitor’s system'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="checkbox-label">
              <input
                type="radio"
                name="status-theme"
                checked={draft.theme === value}
                onChange={() => patch({ theme: value })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <ColorField
          id="brand-accent"
          label="Accent color"
          value={draft.accentColor}
          onChange={(accentColor) => patch({ accentColor })}
        />
        <p className="field-hint">
          Used for the header rule and link underlines. Health states keep their own colors, so
          “operational” and “disrupted” always read clearly.
        </p>
        {showLight && (
          <div className="status-palette">
            <h4>Light palette</h4>
            <div className="status-design-grid three">
              <ColorField
                id="status-backgroundColor"
                label="Page"
                value={lightPalette.background}
                onChange={(backgroundColor) => patch({ backgroundColor })}
              />
              <ColorField
                id="status-surfaceColor"
                label="Cards"
                value={lightPalette.surface}
                onChange={(surfaceColor) => patch({ surfaceColor })}
              />
              <ColorField
                id="status-textColor"
                label="Text"
                value={lightPalette.text}
                onChange={(textColor) => patch({ textColor })}
              />
            </div>
            <ContrastNote draft={draft} theme="light" />
          </div>
        )}
        {showDark && (
          <div className="status-palette">
            <h4>Dark palette</h4>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={customDark}
                onChange={(e) =>
                  patch(
                    e.target.checked
                      ? {
                          darkBackgroundColor: darkDefaults.background,
                          darkSurfaceColor: darkDefaults.surface,
                          darkTextColor: darkDefaults.text,
                        }
                      : { darkBackgroundColor: '', darkSurfaceColor: '', darkTextColor: '' },
                  )
                }
              />
              Use my own dark colors
            </label>
            {customDark && (
              <div className="status-design-grid three">
                <ColorField
                  id="status-darkBackgroundColor"
                  label="Page"
                  value={draft.darkBackgroundColor || darkDefaults.background}
                  onChange={(darkBackgroundColor) => patch({ darkBackgroundColor })}
                />
                <ColorField
                  id="status-darkSurfaceColor"
                  label="Cards"
                  value={draft.darkSurfaceColor || darkDefaults.surface}
                  onChange={(darkSurfaceColor) => patch({ darkSurfaceColor })}
                />
                <ColorField
                  id="status-darkTextColor"
                  label="Text"
                  value={draft.darkTextColor || darkDefaults.text}
                  onChange={(darkTextColor) => patch({ darkTextColor })}
                />
              </div>
            )}
            <ContrastNote draft={draft} theme="dark" />
          </div>
        )}
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            patch({
              accentColor: statusDesignDefaults.accentColor,
              backgroundColor: statusDesignDefaults.backgroundColor,
              surfaceColor: statusDesignDefaults.surfaceColor,
              textColor: statusDesignDefaults.textColor,
              darkBackgroundColor: '',
              darkSurfaceColor: '',
              darkTextColor: '',
            })
          }
        >
          Reset colors to default
        </button>
      </Section>

      <Section title="Layout & type">
        <div className="status-design-grid three">
          <div>
            <label htmlFor="status-layout">Page width</label>
            <select
              id="status-layout"
              value={draft.layout}
              onChange={(e) => patch({ layout: e.target.value as StatusSettings['layout'] })}
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
              <option value="wide">Wide</option>
            </select>
          </div>
          <div>
            <label htmlFor="status-font">Typography</label>
            <select
              id="status-font"
              value={draft.font}
              onChange={(e) => patch({ font: e.target.value as StatusSettings['font'] })}
            >
              <option value="sans">Figtree</option>
              <option value="system">System UI</option>
              <option value="serif">Serif</option>
              <option value="mono">Monospace</option>
            </select>
          </div>
          <div>
            <label htmlFor="status-radius">Corners</label>
            <select
              id="status-radius"
              value={draft.cornerRadius}
              onChange={(e) => patch({ cornerRadius: Number(e.target.value) })}
            >
              {radius.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Section>

      <Section title="Header & footer">
        <label htmlFor="status-header-label">
          Header caption <span className="optional-label">Leave empty to hide</span>
        </label>
        <input
          id="status-header-label"
          maxLength={80}
          value={draft.headerLabel}
          onChange={(e) => patch({ headerLabel: e.target.value })}
        />
        <label htmlFor="status-footer-text">Footer message</label>
        <textarea
          id="status-footer-text"
          rows={2}
          maxLength={300}
          value={draft.footerText}
          onChange={(e) => patch({ footerText: e.target.value })}
        />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.showPoweredBy}
            onChange={(e) => patch({ showPoweredBy: e.target.checked })}
          />
          Show StillUp attribution
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.showIncidentHistory}
            onChange={(e) => patch({ showIncidentHistory: e.target.checked })}
          />
          Show resolved incident history (active incidents always appear)
        </label>
      </Section>

      <Section title="Navigation links" hint={`${links.length} of 8`} open={false}>
        {links.map((link, index) => (
          <div className="notification-card" key={index}>
            <label htmlFor={`status-link-label-${index}`}>Link label</label>
            <input
              id={`status-link-label-${index}`}
              required
              maxLength={60}
              value={link.label}
              onChange={(e) =>
                patch({
                  links: links.map((item, i) =>
                    i === index ? { ...item, label: e.target.value } : item,
                  ),
                })
              }
            />
            <label htmlFor={`status-link-url-${index}`}>Destination URL</label>
            <input
              id={`status-link-url-${index}`}
              type="url"
              required
              value={link.url}
              onChange={(e) =>
                patch({
                  links: links.map((item, i) =>
                    i === index ? { ...item, url: e.target.value } : item,
                  ),
                })
              }
            />
            <button
              className="button secondary"
              type="button"
              onClick={() => patch({ links: links.filter((_, i) => i !== index) })}
            >
              Remove link {index + 1}
            </button>
          </div>
        ))}
        <button
          className="button secondary"
          type="button"
          disabled={links.length >= 8}
          onClick={() => patch({ links: [...links, { label: '', url: '' }] })}
        >
          Add navigation link
        </button>
      </Section>

      <Section title="Content sections" hint={`${content.length} of 12`} open={false}>
        <p className="field-hint">
          Add support instructions, service descriptions, or your incident communication policy.
          Sections appear in the order shown within their placement.
        </p>
        {content.map((block, index) => {
          const update = (change: Partial<typeof block>) =>
            patch({
              content: content.map((item) =>
                item.id === block.id ? { ...item, ...change } : item,
              ),
            });
          return (
            <div className="notification-card" key={block.id}>
              <label htmlFor={`status-block-title-${block.id}`}>Section title</label>
              <input
                id={`status-block-title-${block.id}`}
                required
                maxLength={120}
                value={block.title}
                onChange={(e) => update({ title: e.target.value })}
              />
              <label htmlFor={`status-block-body-${block.id}`}>Content</label>
              <textarea
                id={`status-block-body-${block.id}`}
                rows={4}
                maxLength={4000}
                value={block.body}
                onChange={(e) => update({ body: e.target.value })}
              />
              <label htmlFor={`status-block-position-${block.id}`}>Placement</label>
              <select
                id={`status-block-position-${block.id}`}
                value={block.position}
                onChange={(e) => update({ position: e.target.value as typeof block.position })}
              >
                <option value="before-services">Before services</option>
                <option value="after-services">After services</option>
              </select>
              <div className="notification-actions">
                <button
                  className="button secondary"
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    const next = [...content];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    patch({ content: next });
                  }}
                >
                  Move section up
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => patch({ content: content.filter((item) => item.id !== block.id) })}
                >
                  Remove section {index + 1}
                </button>
              </div>
            </div>
          );
        })}
        <button
          className="button secondary"
          type="button"
          disabled={content.length >= 12}
          onClick={() =>
            patch({
              content: [
                ...content,
                { id: crypto.randomUUID(), title: '', body: '', position: 'after-services' },
              ],
            })
          }
        >
          Add content section
        </button>
      </Section>

      <Section title="Component groups" hint={`${groups.length} groups`} open={false}>
        {groups.map((g) => (
          <div className="notification-card" key={g.id}>
            <label htmlFor={`group-${g.id}`}>Group name</label>
            <input
              id={`group-${g.id}`}
              value={g.name}
              maxLength={80}
              required
              onChange={(e) =>
                patch({
                  groups: groups.map((row) =>
                    row.id === g.id ? { ...row, name: e.target.value } : row,
                  ),
                })
              }
            />
            <button
              type="button"
              className="button secondary"
              onClick={() => patch({ groups: groups.filter((row) => row.id !== g.id) })}
            >
              Remove {g.name || 'group'}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button secondary"
          disabled={groups.length >= 30}
          onClick={() =>
            patch({ groups: [...groups, { id: crypto.randomUUID(), name: '', monitorIds: [] }] })
          }
        >
          Add component group
        </button>
        {monitors
          .filter((m) => !m.archivedAt || groups.some((g) => g.monitorIds.includes(m.id)))
          .map((m) => (
            <div key={m.id}>
              <label htmlFor={`group-assignment-${m.id}`}>
                {m.config.name}
                {m.config.public && !m.archivedAt ? '' : ' (private or archived)'}
              </label>
              <select
                id={`group-assignment-${m.id}`}
                value={groups.find((g) => g.monitorIds.includes(m.id))?.id ?? ''}
                onChange={(e) =>
                  patch({
                    groups: groups.map((g) => ({
                      ...g,
                      monitorIds:
                        g.id === e.target.value
                          ? [...g.monitorIds.filter((id) => id !== m.id), m.id]
                          : g.monitorIds.filter((id) => id !== m.id),
                    })),
                  })
                }
              >
                <option value="">Ungrouped</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name || 'Unnamed group'}
                  </option>
                ))}
              </select>
            </div>
          ))}
        <p className="field-hint">
          Groups appear only when they contain a published component. Grouping a private check does
          not publish it.
        </p>
      </Section>

      <Section title="Domain & headless" open={false}>
        <p className="field-hint">
          Serve this page at status.yourdomain.com through your hosting provider or CDN. Configure
          the hostname on your deployment, point DNS at your ingress, and enable HTTPS. Changes
          apply to /status and every configured custom domain.{' '}
          <a href="/docs/status-page#custom-domain" target="_blank" rel="noreferrer">
            Custom domain setup guide ↗
          </a>
        </p>
        <p className="field-hint">
          Need a completely bespoke frontend? Build with the public status API and host your own
          design.{' '}
          <a href="/docs/status-page#headless" target="_blank" rel="noreferrer">
            Read the headless guide ↗
          </a>
        </p>
      </Section>
    </>
  );
}
