'use client';
import type { StatusSettings } from '@stillup/core';

export function StatusDesignFields({
  settings,
  links,
  setLinks,
  content,
  setContent,
}: {
  settings: StatusSettings;
  links: StatusSettings['links'];
  setLinks: (value: StatusSettings['links']) => void;
  content: StatusSettings['content'];
  setContent: (value: StatusSettings['content']) => void;
}) {
  return (
    <>
      <h3 className="notification-heading">Make it yours</h3>
      <p className="field-hint">
        Choose a look, add helpful content, and preview before saving. Your changes apply to /status
        and every configured custom domain.
      </p>
      <div className="status-design-grid">
        {(
          [
            ['theme', 'Theme', ['light', 'dark', 'auto']],
            ['layout', 'Page width & spacing', ['comfortable', 'compact', 'wide']],
            ['font', 'Typography', ['sans', 'system', 'mono', 'serif']],
          ] as const
        ).map(([name, label, options]) => (
          <div key={name}>
            <label htmlFor={`status-${name}`}>{label}</label>
            <select id={`status-${name}`} name={name} defaultValue={settings[name]}>
              {options.map((value) => (
                <option key={value} value={value}>
                  {value === 'auto'
                    ? 'Follow visitor’s system'
                    : value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div>
          <label htmlFor="status-radius">Corner radius (px)</label>
          <input
            id="status-radius"
            name="cornerRadius"
            type="number"
            min={0}
            max={32}
            defaultValue={settings.cornerRadius}
          />
        </div>
        {(['backgroundColor', 'surfaceColor', 'textColor'] as const).map((name) => (
          <div key={name}>
            <label htmlFor={`status-${name}`}>
              {name === 'backgroundColor'
                ? 'Page background'
                : name === 'surfaceColor'
                  ? 'Card background'
                  : 'Text color'}
            </label>
            <input id={`status-${name}`} type="color" name={name} defaultValue={settings[name]} />
          </div>
        ))}
      </div>
      <p className="field-hint">
        Background, card, and text colors apply to the light theme. Dark mode uses a readable dark
        palette.
      </p>
      <label htmlFor="status-favicon">Favicon URL</label>
      <input id="status-favicon" type="url" name="faviconUrl" defaultValue={settings.faviconUrl} />
      <label htmlFor="status-header-label">Header caption</label>
      <input
        id="status-header-label"
        name="headerLabel"
        maxLength={80}
        defaultValue={settings.headerLabel}
      />
      <label htmlFor="status-footer-text">Footer message</label>
      <textarea
        id="status-footer-text"
        name="footerText"
        maxLength={300}
        defaultValue={settings.footerText}
      />
      <label className="checkbox-label">
        <input type="checkbox" name="showPoweredBy" defaultChecked={settings.showPoweredBy} />
        Show StillUp attribution
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          name="showIncidentHistory"
          defaultChecked={settings.showIncidentHistory}
        />
        Show resolved incident history (active incidents always appear)
      </label>
      <h3 className="notification-heading">Navigation links</h3>
      {links.map((link, index) => (
        <div className="notification-card" key={index}>
          <label htmlFor={`status-link-label-${index}`}>Link label</label>
          <input
            id={`status-link-label-${index}`}
            required
            maxLength={60}
            value={link.label}
            onChange={(e) =>
              setLinks(
                links.map((item, i) => (i === index ? { ...item, label: e.target.value } : item)),
              )
            }
          />
          <label htmlFor={`status-link-url-${index}`}>Destination URL</label>
          <input
            id={`status-link-url-${index}`}
            type="url"
            required
            value={link.url}
            onChange={(e) =>
              setLinks(
                links.map((item, i) => (i === index ? { ...item, url: e.target.value } : item)),
              )
            }
          />
          <button
            className="button secondary"
            type="button"
            onClick={() => setLinks(links.filter((_, i) => i !== index))}
          >
            Remove link {index + 1}
          </button>
        </div>
      ))}
      <button
        className="button secondary"
        type="button"
        disabled={links.length >= 8}
        onClick={() => setLinks([...links, { label: '', url: '' }])}
      >
        Add navigation link
      </button>
      <h3 className="notification-heading">Content sections</h3>
      <p className="field-hint">
        Add support instructions, service descriptions, or your incident communication policy.
        Sections appear in the order shown within their placement.
      </p>
      {content.map((block, index) => (
        <div className="notification-card" key={block.id}>
          <label htmlFor={`status-block-title-${block.id}`}>Section title</label>
          <input
            id={`status-block-title-${block.id}`}
            required
            maxLength={120}
            value={block.title}
            onChange={(e) =>
              setContent(
                content.map((item) =>
                  item.id === block.id ? { ...item, title: e.target.value } : item,
                ),
              )
            }
          />
          <label htmlFor={`status-block-body-${block.id}`}>Content</label>
          <textarea
            id={`status-block-body-${block.id}`}
            rows={4}
            maxLength={4000}
            value={block.body}
            onChange={(e) =>
              setContent(
                content.map((item) =>
                  item.id === block.id ? { ...item, body: e.target.value } : item,
                ),
              )
            }
          />
          <label htmlFor={`status-block-position-${block.id}`}>Placement</label>
          <select
            id={`status-block-position-${block.id}`}
            value={block.position}
            onChange={(e) =>
              setContent(
                content.map((item) =>
                  item.id === block.id
                    ? { ...item, position: e.target.value as typeof block.position }
                    : item,
                ),
              )
            }
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
                setContent(next);
              }}
            >
              Move section up
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={() => setContent(content.filter((item) => item.id !== block.id))}
            >
              Remove section {index + 1}
            </button>
          </div>
        </div>
      ))}
      <button
        className="button secondary"
        type="button"
        disabled={content.length >= 12}
        onClick={() =>
          setContent([
            ...content,
            { id: crypto.randomUUID(), title: '', body: '', position: 'after-services' },
          ])
        }
      >
        Add content section
      </button>
      <h3 className="notification-heading">Your domain, your delivery</h3>
      <p className="field-hint">
        Serve this page at status.yourdomain.com through your hosting provider or CDN. Configure the
        hostname on your deployment, point DNS at your ingress, and enable HTTPS.{' '}
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
    </>
  );
}
