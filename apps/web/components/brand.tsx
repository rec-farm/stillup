'use client';
import { useState } from 'react';
import { useWorkspace } from './workspace-provider';
import { EyeMark } from './eye-mark';

/**
 * StillUp identity. Shows the official lockup files (cream on dark, ink on Paper; CSS hides
 * the wrong colorway) unless `workspace` is set and the workspace has its own name or logo,
 * in which case it renders that logo (or the StillUp mark) beside the live workspace name.
 */
export function Brand({ workspace = false }: { workspace?: boolean }) {
  const { settings } = useWorkspace();
  const [failedUrl, setFailedUrl] = useState('');
  const logo = workspace ? settings.logoUrl : '';
  const custom = workspace && (!!logo || settings.name !== 'StillUp');
  if (!custom) {
    return (
      <span className="brand brand-official" title="StillUp">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="brand-lockup brand-lockup-cream"
          src="/brand/stillup-lockup-cream.svg"
          width={110}
          height={36}
          alt="StillUp"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="brand-lockup brand-lockup-ink"
          src="/brand/stillup-lockup-ink.svg"
          width={110}
          height={36}
          alt="StillUp"
        />
      </span>
    );
  }
  const name = settings.name;
  return (
    <span className="brand" title={name}>
      {logo && logo !== failedUrl ? (
        <img
          className="brand-mark"
          src={logo}
          width={32}
          height={32}
          alt=""
          onError={() => setFailedUrl(logo)}
        />
      ) : (
        <EyeMark className="brand-mark brand-eye" />
      )}
      <span className="brand-name">{name}</span>
    </span>
  );
}
