import Link from 'next/link';
import { notFound } from 'next/navigation';
import { docs } from '../../../lib/docs';
import { DocsCode } from '../../../components/docs-code';
export const dynamicParams = false;
export function generateStaticParams() {
  return docs.map(({ slug }) => ({ slug }));
}
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = docs.find((p) => p.slug === slug);
  return { title: doc?.title ?? 'Guide not found', description: doc?.description };
}
export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = docs.find((p) => p.slug === slug);
  if (!doc) notFound();
  const next = docs[(docs.indexOf(doc) + 1) % docs.length]!;
  return (
    <article className="docs-article">
      <div className="eyebrow">{doc.category}</div>
      <h1>{doc.title}</h1>
      <p className="docs-lead">{doc.description}</p>
      <nav className="docs-toc" aria-label="On this page">
        <strong>On this page</strong>
        {doc.sections.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.title}
          </a>
        ))}
      </nav>
      {doc.sections.map((s) => (
        <section key={s.id} id={s.id} className="docs-section">
          <h2>
            <a href={`#${s.id}`}>{s.title}</a>
          </h2>
          {s.paragraphs?.map((p) => (
            <p key={p}>{p}</p>
          ))}
          {s.code && <DocsCode code={s.code} language={s.language} />}
          {s.fields && (
            <div
              className="docs-table-wrap"
              tabIndex={0}
              role="region"
              aria-label="Check configuration fields"
            >
              <table className="docs-table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Default</th>
                    <th scope="col">Meaning</th>
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
                      <td>{field.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {s.steps && (
            <ol>
              {s.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </section>
      ))}
      <footer className="docs-article-footer">
        <Link href="/docs">← All guides</Link>
        <Link href={`/docs/${next.slug}`}>{next.title} →</Link>
      </footer>
    </article>
  );
}
