import DocsLayout from '../app/docs/layout';
import DocsHome from '../app/docs/page';
import DocPage from '../app/docs/[slug]/page';
import { docs } from '../lib/docs';
export default function DocsPage() {
  const slug = window.location.pathname.replace(/^\/docs\/?/, '');
  document.title = `${slug ? (docs.find((doc) => doc.slug === slug)?.title ?? 'Guide not found') : 'Documentation'} · StillUp`;
  return <DocsLayout>{slug ? <DocPage slug={slug} /> : <DocsHome />}</DocsLayout>;
}
