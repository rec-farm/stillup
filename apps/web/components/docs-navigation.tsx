'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

export function DocsNavigation({
  pages,
}: {
  pages: { slug: string; title: string; description: string; category: string }[];
}) {
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  const matches = pages.filter((p) =>
    `${p.title} ${p.description}`.toLowerCase().includes(query.toLowerCase().trim()),
  );
  return (
    <>
      <label className="docs-search-label" htmlFor="docs-search">
        Find a guide
      </label>
      <input
        id="docs-search"
        className="docs-search"
        type="search"
        placeholder="Search guides…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <nav aria-label="Documentation">
        <Link
          className="docs-nav-link"
          href="/docs"
          aria-current={pathname === '/docs' ? 'page' : undefined}
        >
          Documentation home
        </Link>
        {['Start here', 'Guides', 'Reference'].map((category) => {
          const group = matches.filter((p) => p.category === category);
          return group.length ? (
            <div key={category}>
              <p className="docs-nav-heading">{category}</p>
              {group.map((p) => (
                <Link
                  key={p.slug}
                  className="docs-nav-link"
                  href={`/docs/${p.slug}`}
                  aria-current={pathname === `/docs/${p.slug}` ? 'page' : undefined}
                >
                  {p.title}
                </Link>
              ))}
            </div>
          ) : null;
        })}
        {query && (
          <p className="docs-search-result" role="status">
            {matches.length
              ? `${matches.length} guides found`
              : 'No matching guides. Try “secrets” or “code”.'}
          </p>
        )}
      </nav>
    </>
  );
}
