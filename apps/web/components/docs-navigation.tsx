'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function DocsNavigation({
  pages,
}: {
  pages: {
    slug: string;
    title: string;
    description: string;
    category: string;
    searchText: string;
  }[];
}) {
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key !== '/' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.isContentEditable ||
        target?.closest('input, textarea, select')
      )
        return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const matches = pages.filter((p) =>
    `${p.title} ${p.description} ${p.searchText}`
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  );
  return (
    <>
      <label className="docs-search-label" htmlFor="docs-search">
        Find a guide
      </label>
      <div className="docs-search-wrap">
        <Search size={15} aria-hidden="true" />
        <input
          ref={input}
          id="docs-search"
          className="docs-search"
          type="search"
          placeholder="Search documentation…"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('');
              input.current?.blur();
            }
          }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd aria-hidden="true">/</kbd>
      </div>
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
              ? `${matches.length} ${matches.length === 1 ? 'guide' : 'guides'} found`
              : 'No matching guides. Try “secrets” or “code”.'}
          </p>
        )}
      </nav>
    </>
  );
}
