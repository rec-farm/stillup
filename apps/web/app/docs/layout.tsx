import { Link } from '../../lib/navigation';
import { Brand } from '../../components/brand';
import { DocsNavigation } from '../../components/docs-navigation';
import { docs } from '../../lib/docs';
import './docs.css';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs-shell">
      <a href="#docs-main" className="docs-skip">
        Skip to content
      </a>
      <header className="docs-header">
        <Link href="/" aria-label="StillUp home">
          <Brand />
        </Link>
        <span className="docs-header-label">Documentation</span>
        <Link className="button secondary" href="/">
          Open dashboard ↗
        </Link>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar">
          <DocsNavigation
            pages={docs.map(({ slug, title, description, category, sections }) => ({
              slug,
              title,
              description,
              category,
              searchText: sections
                .map((section) =>
                  [
                    section.title,
                    ...(section.paragraphs ?? []),
                    ...(section.endpoints ?? []).map(
                      (endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.description}`,
                    ),
                  ].join(' '),
                )
                .join(' '),
            }))}
          />
        </aside>
        <main id="docs-main" className="docs-main">
          {children}
        </main>
      </div>
    </div>
  );
}
