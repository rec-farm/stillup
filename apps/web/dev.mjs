import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Read before loading .env, whose PORT belongs to the API. portless sets PORT for this process.
const port = process.env.PORT ?? '3000';
loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
const cli = fileURLToPath(new URL('./node_modules/next/dist/bin/next', import.meta.url));
const child = spawn(
  process.execPath,
  [cli, 'dev', '--hostname', '127.0.0.1', '--port', port, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
