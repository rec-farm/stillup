import { EyeMark } from '../components/eye-mark';

export default function Loading() {
  return (
    <main className="unavailable" aria-busy="true">
      <EyeMark className="loading-eye" />
      <p role="status">Loading workspace…</p>
    </main>
  );
}
