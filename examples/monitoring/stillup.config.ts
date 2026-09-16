import { defineConfig } from '../../packages/sdk/src/index';

export default defineConfig({
  version: 1,
  project: 'example-api',
  checks: [
    {
      id: 'api-health',
      config: {
        name: 'API health',
        url: 'https://api.example.com/health',
        intervalSeconds: 60,
        expectedStatus: 200,
        headers: { Authorization: 'Bearer {{API_TOKEN}}' },
        jsonAssertions: [{ path: '$.status', equals: 'ok' }],
        public: false,
      },
    },
  ],
});
