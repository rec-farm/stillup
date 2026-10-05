import type { AnchorHTMLAttributes } from 'react';

// Native navigation keeps links, downloads, modifier clicks and no-script semantics intact.
export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />;
}
export function usePathname() {
  return window.location.pathname;
}
