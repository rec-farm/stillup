'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="unavailable">
      <h1>We couldn’t load this page</h1>
      <p>Your monitoring data hasn’t been changed.</p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
