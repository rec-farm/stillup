import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(resolve(tmpdir(), 'stillup-package-'));
const env = { ...process.env };
delete env.STILLUP_URL;
delete env.STILLUP_ADMIN_TOKEN;
const fixture = {
  version: 1,
  project: 'package-test',
  checks: [{ id: 'ready', config: { name: 'Ready', url: 'https://example.com/readyz' } }],
};
try {
  // Lifecycle scripts can write to stdout even with npm's --json flag.
  // Run the same prepack hook separately to keep package metadata parseable.
  await exec('npm', ['run', 'prepack'], { cwd: packageDir, env });
  const packed = await exec(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', temp],
    {
      cwd: packageDir,
      env,
    },
  );
  const [pack] = JSON.parse(packed.stdout);
  assert(pack.files.some((file) => file.path === 'dist/cli.js'));
  assert(pack.files.some((file) => file.path.endsWith('index.d.ts')));
  assert(!pack.files.some((file) => /(^|\/)\.env|node_modules|scripts\//.test(file.path)));
  await writeFile(resolve(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await exec(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve(temp, pack.filename)],
    {
      cwd: temp,
      env,
      timeout: 120000,
    },
  );
  const installed = JSON.parse(
    await readFile(resolve(temp, 'node_modules/@rec/stillup/package.json'), 'utf8'),
  );
  assert.equal(installed.name, '@rec/stillup');
  assert(!Object.keys(installed.dependencies).some((name) => name.startsWith('@stillup/')));
  const cli = resolve(temp, 'node_modules/.bin/stillup');
  assert.match(
    (await exec(cli, ['--help'], { cwd: temp, env })).stdout,
    /validate\|test\|diff\|apply/,
  );
  await writeFile(resolve(temp, 'config.json'), JSON.stringify(fixture));
  for (const extension of ['ts', 'mts', 'js', 'mjs']) {
    await writeFile(
      resolve(temp, `config.${extension}`),
      `import { defineConfig } from '@rec/stillup';\nexport default defineConfig(${JSON.stringify(fixture)});\n`,
    );
  }
  for (const extension of ['json', 'ts', 'mts', 'js', 'mjs']) {
    const result = await exec(cli, ['validate', '--config', `config.${extension}`, '--json'], {
      cwd: temp,
      env,
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      valid: true,
      project: 'package-test',
      checks: 1,
    });
  }
  await writeFile(
    resolve(temp, 'invalid.json'),
    JSON.stringify({ ...fixture, project: 'INVALID' }),
  );
  await assert.rejects(
    exec(cli, ['validate', '--config', 'invalid.json'], { cwd: temp, env }),
    (error) => error.code === 1 && error.stderr.includes('project'),
  );
  await writeFile(
    resolve(temp, 'types.ts'),
    `
import { defineConfig, createClient, type CodeConfig } from '@rec/stillup';
const config: CodeConfig = defineConfig(${JSON.stringify(fixture)});
createClient({ baseUrl: 'https://example.com/api', token: 'test' }).plan(config);
// @ts-expect-error Invalid methods must be rejected by the published declarations.
defineConfig({ version: 1, project: 'test', checks: [{ id: 'test', config: { name: 'Test', url: 'https://example.com', method: 'INVALID' } }] });
`,
  );
  await exec(
    process.execPath,
    [
      resolve(packageDir, '../../node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'types.ts',
    ],
    { cwd: temp, env },
  );
  console.log('Packed package passes standalone CLI, config-loading, SDK, and declaration checks.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
