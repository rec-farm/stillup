import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@stillup/core'],
  poweredByHeader: false,
};
export default config;
