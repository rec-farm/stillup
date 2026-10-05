import { Link } from '../../../lib/navigation';
import { docs } from '../../../lib/docs';
import { Info, TriangleAlert, Hash, Clock3, ChevronRight } from 'lucide-react';
import { DocsInline } from '../../../components/docs-inline';
import { DocsToc } from '../../../components/docs-toc';
import { DocsCode } from '../../../components/docs-code';
export default function DocPage({ slug }: { slug: string }) {
  const doc = docs.find((p) => p.slug === slug);
  if (!doc) return <h1>Guide not found.</h1>;
  const next = docs[(docs.indexOf(doc) + 1) % docs.length]!;
  return (
    <article className="docs-article">
      <div className="docs-breadcrumb">
        <Link href="/docs">Documentation</Link>
        <ChevronRight size={13} aria-hidden="true" />
        <span>{doc.category}</span>
      </div>
      <div className="docs-page-meta">
        <span className="eyebrow">{doc.category}</span>
        <span>
          <Clock3 size={13} aria-hidden="true" />
          {Math.max(1, Math.ceil(JSON.stringify(doc.sections).split(/\s+/).length / 220))} min read
        </span>
      </div>
      <h1>
        {doc.title}
        <span className="period">.</span>
      </h1>
      <p className="docs-lead">{doc.description}</p>
      <div className="docs-reading-layout">
        <DocsToc sections={doc.sections.map(({ id, title }) => ({ id, title }))} />
        <div className="docs-body">
          {doc.sections.map((s) => (
            <section key={s.id} id={s.id} className="docs-section">
              <h2>
                <a href={`#${s.id}`}>
                  {s.title}
                  <Hash size={17} className="docs-heading-anchor" aria-hidden="true" />
                </a>
              </h2>
              {s.paragraphs?.map((p) => (
                <p key={p}>
                  <DocsInline text={p} />
                </p>
              ))}
              {s.endpoints && (
                <div className="docs-endpoints">
                  {s.endpoints.map((endpoint) => (
                    <div className="docs-endpoint" key={`${endpoint.method}:${endpoint.path}`}>
                      <div>
                        <span className="docs-method" data-method={endpoint.method}>
                          {endpoint.method}
                        </span>
                        <code>{endpoint.path}</code>
                      </div>
                      <p>
                        <DocsInline text={endpoint.description} />
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {s.callout && (
                <aside className={`docs-callout ${s.callout.tone ?? 'note'}`}>
                  {s.callout.tone === 'warning' ? (
                    <TriangleAlert size={18} aria-hidden="true" />
                  ) : (
                    <Info size={18} aria-hidden="true" />
                  )}
                  <div>
                    <strong>{s.callout.title}</strong>
                    <p>
                      <DocsInline text={s.callout.body} />
                    </p>
                  </div>
                </aside>
              )}
              {s.code && <DocsCode code={s.code} language={s.language} title={s.codeTitle} />}
              {s.examples?.map((example) => (
                <DocsCode key={example.title} {...example} />
              ))}
              {s.fields && (
                <div className="docs-table-wrap" tabIndex={0} role="region" aria-label={s.title}>
                  <table className="docs-table">
                    <thead>
                      <tr>
                        <th scope="col">{s.fieldColumns?.[0] ?? 'Field'}</th>
                        <th scope="col">{s.fieldColumns?.[1] ?? 'Default'}</th>
                        <th scope="col">{s.fieldColumns?.[2] ?? 'Meaning'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.fields.map((field) => (
                        <tr key={field.name}>
                          <th scope="row">
                            <code>{field.name}</code>
                          </th>
                          <td>
                            <code>{field.default}</code>
                          </td>
                          <td>
                            <DocsInline text={field.description} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {s.steps && (
                <ol>
                  {s.steps.map((step) => (
                    <li key={step}>
                      <DocsInline text={step} />
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
          <footer className="docs-article-footer">
            <Link href="/docs">← All guides</Link>
            <Link href={`/docs/${next.slug}`}>{next.title} →</Link>
          </footer>
        </div>
      </div>
    </article>
  );
}
