import type { NextConfig } from 'next';
const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@stillup/core'],
  poweredByHeader: false,
  allowedDevOrigins: ['stillup.localhost', '*.stillup.localhost'],
};
export default config;
