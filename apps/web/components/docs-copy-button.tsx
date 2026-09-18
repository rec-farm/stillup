'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
export function DocsCopyButton({ code }: { code: string }) {
  const [state, setState] = useState('Copy');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <>
      <button
        type="button"
        aria-label={state === 'Copy' ? 'Copy code' : state}
        onClick={async () => {
          if (timer.current) clearTimeout(timer.current);
          try {
            await navigator.clipboard.writeText(code);
            setState('Copied');
          } catch {
            setState('Select text to copy');
          }
          timer.current = setTimeout(() => setState('Copy'), 2500);
        }}
      >
        {state === 'Copied' ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
        {state}
      </button>
      <span className="sr-only" role="status">
        {state !== 'Copy' ? state : ''}
      </span>
    </>
  );
}
