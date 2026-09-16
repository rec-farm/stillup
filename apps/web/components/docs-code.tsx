'use client';
import { useState } from 'react';
export function DocsCode({ code, language }: { code: string; language?: string }) {
  const [state, setState] = useState('Copy');
  return (
    <div className="docs-code">
      <div className="docs-code-bar">
        <span>{language ?? 'Example'}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setState('Copied');
            } catch {
              setState('Select text to copy');
            }
          }}
        >
          {state}
        </button>
        <span className="sr-only" role="status">
          {state !== 'Copy' ? state : ''}
        </span>
      </div>
      <pre tabIndex={0} aria-label={`${language ?? 'Code'} example`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
