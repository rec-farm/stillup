import { Activity } from 'lucide-react';
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <Activity size={22} strokeWidth={2.6} />
      </span>
      StillUp<span className="brand-dot">.</span>
    </span>
  );
}
