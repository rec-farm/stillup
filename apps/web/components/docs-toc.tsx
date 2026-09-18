'use client';
import { useEffect, useState } from 'react';
import { List, ArrowUp } from 'lucide-react';
export function DocsToc({ sections }: { sections: { id: string; title: string }[] }) {
  const [active, setActive] = useState(sections[0]?.id);
  useEffect(() => {
    const update = () => {
      const ids = sections.filter(
        ({ id }) => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= 150,
      );
      setActive(ids.at(-1)?.id ?? sections[0]?.id);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [sections]);
  return (
    <nav className="docs-toc" aria-label="On this page">
      <strong>
        <List size={14} aria-hidden="true" />
        On this page
      </strong>
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={active === section.id ? 'location' : undefined}
        >
          {section.title}
        </a>
      ))}
      <a className="docs-back-top" href="#docs-main">
        <ArrowUp size={13} aria-hidden="true" />
        Back to top
      </a>
    </nav>
  );
}
