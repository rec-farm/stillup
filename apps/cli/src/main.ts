import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
import {
  codeConfigSchema,
  createClient,
  githubActionsToken,
  ConfigurationError,
  type CodePlan,
} from '@stillup/sdk';

const help = `StillUp monitoring as code

pnpm stillup <validate|test|diff|apply> --config <file.ts|file.json>

validate  Validate locally; no token or server needed
test      Send each selected request once from the API server (--yes required)
diff      Preview creates, changed fields, and retained checks; no writes
apply     Preview and atomically apply to this project (--yes required)

--config  Defaults to stillup.config.ts; TypeScript files execute locally
--id      Test only this check ID (test only)
--check   Exit 2 for changes or retained checks (diff only)
--yes     Acknowledge real requests (test) or configuration writes (apply)
--json    Machine-readable output
--help    Show this help

STILLUP_URL          Browser origin + /api (e.g. https://status.example.com/api)
STILLUP_TOKEN        An API key from StillUp (never put it in a config)
In GitHub Actions, a job with \`permissions: id-token: write\` signs in as a trusted
workflow instead, with no stored secret. Add the trust rule under API access in StillUp.
STILLUP_ADMIN_TOKEN, the installation administrator token, still works but is not advised.
Exit codes: 0 success, 1 error/test failure, 2 diff --check detects changes.
No automatic deletion, adoption, or ownership transfer. Omitted checks are retained.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'stillup.config.ts' },
      id: { type: 'string' },
      check: { type: 'boolean' },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (positionals.length !== 1 || !['validate', 'test', 'diff', 'apply'].includes(command))
    throw new Error('Choose validate, test, diff, or apply. See --help.');
  if (values.id && command !== 'test') throw new Error('--id is supported only by test.');
  if (values.check && command !== 'diff') throw new Error('--check is supported only by diff.');
  if (['test', 'apply'].includes(command) && !values.yes)
    throw new Error(
      `${command} requires --yes. ${command === 'test' ? 'Tests send real requests and may change data at the target.' : 'Run diff to review the changes first.'}`,
    );
  const filename = resolve(values.config!);
  if (!['.ts', '.mts', '.js', '.mjs', '.json'].includes(extname(filename)))
    throw new Error('Use a TypeScript, JavaScript, or JSON configuration file.');
  let input: unknown;
  try {
    input =
      extname(filename) === '.json'
        ? JSON.parse(await readFile(filename, 'utf8'))
        : ['.ts', '.mts'].includes(extname(filename))
          ? (await tsImport(pathToFileURL(filename).href, import.meta.url)).default
          : (await import(pathToFileURL(filename).href)).default;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new Error(
      'Could not load the configuration. Check its path, syntax, imports, and default export.',
    );
  }
  const parsed = codeConfigSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  const config = parsed.data;
  if (command === 'validate') {
    console.log(
      values.json
        ? JSON.stringify({ valid: true, project: config.project, checks: config.checks.length })
        : `Valid: ${config.project} (${config.checks.length} checks). Server references are checked by diff/apply.`,
    );
    return;
  }
  const { STILLUP_URL, STILLUP_TOKEN, STILLUP_ADMIN_TOKEN, GITHUB_ACTIONS } = process.env;
  if (!STILLUP_URL) throw new Error('Set STILLUP_URL. See --help.');
  const token =
    STILLUP_TOKEN ||
    STILLUP_ADMIN_TOKEN ||
    (GITHUB_ACTIONS === 'true'
      ? await githubActionsToken({
          baseUrl: STILLUP_URL,
          requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
          requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        })
      : undefined);
  if (!token)
    throw new Error(
      'Set STILLUP_TOKEN to an API key, or run in GitHub Actions as a trusted workflow. See --help.',
    );
  const client = createClient({ baseUrl: STILLUP_URL, token });
  if (command === 'test') {
    const checks = config.checks.filter((c) => !values.id || c.id === values.id);
    if (!checks.length) throw new Error('No matching checks to test.');
    const results = [];
    for (const [index, check] of checks.entries()) {
      // Tests share the API's ten-per-minute bucket with dashboard previews.
      if (index) await setTimeout(6100);
      const result = await client.test(check.config);
      results.push({ id: check.id, ...result });
      if (!values.json) {
        console.log(
          `${result.outcome.toUpperCase()} ${check.id}: HTTP ${result.statusCode ?? '—'}, ${result.durationMs} ms`,
        );
        for (const failure of result.failures) console.log(`  ${failure}`);
      }
    }
    if (values.json) console.log(JSON.stringify({ project: config.project, results }, null, 2));
    if (results.some((r) => r.outcome !== 'pass')) process.exitCode = 1;
    return;
  }
  const plan = await client.plan(config);
  function printPlan(plan: CodePlan) {
    if (values.json) return;
    console.log(`Project: ${plan.project}`);
    for (const change of plan.changes)
      console.log(
        `${change.action.toUpperCase()} ${change.id}${change.fields.length ? ` (${change.fields.join(', ')})` : ''}${change.archived ? ' [archived]' : change.paused ? ' [paused]' : ''}`,
      );
    if (plan.changes.some((c) => c.action === 'retained'))
      console.log(
        'Omitted checks remain unchanged. Archive them explicitly in the dashboard if no longer needed.',
      );
  }
  printPlan(plan);
  if (command === 'apply') {
    const result = await client.apply(config, plan.token);
    console.log(
      values.json
        ? JSON.stringify({ applied: true, ...result }, null, 2)
        : 'Applied. Existing pauses and archives are preserved.',
    );
  } else {
    if (values.json) console.log(JSON.stringify(plan, null, 2));
    if (values.check && plan.changes.some((c) => c.action !== 'unchanged')) process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'StillUp command failed.');
  process.exitCode = 1;
});
