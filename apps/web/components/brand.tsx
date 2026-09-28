'use client';
import { useState } from 'react';
import Image from 'next/image';
import { useWorkspace } from './workspace-provider';
import { EyeMark } from './eye-mark';
export function Brand({ workspace = false }: { workspace?: boolean }) {
  const { settings } = useWorkspace();
  const name = workspace ? settings.name : 'StillUp';
  const logo = workspace ? settings.logoUrl : '';
  const [failedUrl, setFailedUrl] = useState('');
  return (
    <span className="brand" title={name}>
      {logo && logo !== failedUrl ? (
        <Image
          className="brand-mark"
          src={logo}
          width={33}
          height={33}
          alt=""
          unoptimized
          onError={() => setFailedUrl(logo)}
        />
      ) : (
        <EyeMark className="brand-mark brand-eye" />
      )}
      <span className="brand-name">{name}</span>
    </span>
  );
}
