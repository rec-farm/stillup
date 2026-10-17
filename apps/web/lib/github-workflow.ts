/** Single-quoted YAML scalar, safe for any value. */
const yaml = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** "owner/name" from what people paste: owner/name, a GitHub URL, or a clone URL. */
export function repositoryName(input: string): string | null {
  const value = input
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com[/:]/i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(value) && !/\/\.\.?$/.test(value)
    ? value
    : null;
}

/** The workflow file name from a name or a path such as .github/workflows/monitoring.yml. */
export const workflowName = (input: string) =>
  input
    .trim()
    .replace(/^\.?\/?\.github\/workflows\//, '')
    .trim();

export type WorkflowOptions = {
  /** Browser origin + /api. */
  stillupUrl: string;
  branch: string | null;
  environment: string | null;
  config: string;
  cliVersion: string;
};

/** A workflow that deploys monitoring as code as a trusted workflow, with no stored secret. */
export function githubWorkflow({
  stillupUrl,
  branch,
  environment,
  config,
  cliVersion,
}: WorkflowOptions): string {
  return [
    '# Deploys StillUp monitoring as code. GitHub vouches for each run, so no key is stored here.',
    'name: Monitoring',
    'on:',
    '  push:',
    `    branches: [${yaml(branch || 'main')}]`,
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'concurrency:',
    '  group: stillup-monitoring',
    '  cancel-in-progress: false',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    ...(environment ? [`    environment: ${yaml(environment)}`] : []),
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '      - uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 24',
    '      # If your configuration imports @rec/stillup, install your dependencies here and run',
    '      # the stillup binary from them instead of npx.',
    `      - run: npx --yes @rec/stillup@${cliVersion} apply --config ${yaml(config)} --yes`,
    '        env:',
    `          STILLUP_URL: ${yaml(stillupUrl)}`,
    '',
  ].join('\n');
}

/** GitHub's "create a file" page, prefilled with the workflow. */
export const newWorkflowUrl = (
  repository: string,
  branch: string | null,
  workflow: string,
  content: string,
) =>
  `https://github.com/${repository}/new/${encodeURIComponent(branch || 'main')}?${new URLSearchParams(
    { filename: `.github/workflows/${workflow}`, value: content },
  )}`;
