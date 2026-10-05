import { Link } from '../../lib/navigation';
import { docs } from '../../lib/docs';
import { WatchfulArt } from '../../components/watchful-art';
export default function DocsHome() {
  return (
    <>
      <div className="docs-cover">
        <div>
          <div className="eyebrow">The StillUp handbook</div>
          <h1>
            A little guidance.
            <br />A lot of peace of mind<span className="period">.</span>
          </h1>
          <p className="docs-lead">
            Set up your first check, understand an outage, or bring your monitoring into version
            control.
          </p>
        </div>
        <WatchfulArt />
      </div>
      <div className="docs-start-grid">
        <Link href="/docs/getting-started" className="docs-start-card">
          <span className="eyebrow">Start with the dashboard</span>
          <h2>
            Your first check <span>↗</span>
          </h2>
          <p>From an endpoint to your first observation in a few steps.</p>
        </Link>
        <Link href="/docs/monitoring-as-code" className="docs-start-card">
          <span className="eyebrow">Start with your repository</span>
          <h2>
            Monitoring as code <span>↗</span>
          </h2>
          <p>Define, validate, preview, and apply HTTP checks with TypeScript or JSON.</p>
        </Link>
      </div>
      <h2 className="docs-index-heading">Make yourself at home</h2>
      <div className="docs-guide-grid">
        {docs
          .filter((p) => p.category !== 'Start here')
          .map((p) => (
            <Link href={`/docs/${p.slug}`} key={p.slug} className="docs-guide-card">
              <h3>
                {p.title} <span>→</span>
              </h3>
              <p>{p.description}</p>
            </Link>
          ))}
      </div>
      <p className="docs-footer-note">
        StillUp 0.1 · Self-hosted HTTP monitoring. The SDK and CLI currently run from your checkout.
      </p>
    </>
  );
}
