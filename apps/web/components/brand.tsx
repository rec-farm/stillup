'use client';
import { useState } from 'react';
import Image from 'next/image';
import { useWorkspace } from './workspace-provider';
export function Brand({ workspace = false }: { workspace?: boolean }) {
  const { settings } = useWorkspace();
  const name = workspace ? settings.name : 'StillUp';
  const logo = workspace ? settings.logoUrl : '';
  const [failedUrl, setFailedUrl] = useState('');
  return (
    <span className="brand" title={name}>
      <Image
        className="brand-mark"
        src={logo && logo !== failedUrl ? logo : '/brand/stillup-mark.svg'}
        width={33}
        height={33}
        alt=""
        unoptimized
        onError={() => setFailedUrl(logo)}
      />
      <span className="brand-name">{name}</span>
      {name === 'StillUp' && <span className="brand-dot">.</span>}
    </span>
  );
}
