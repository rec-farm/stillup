import { describe, expect, it } from 'vitest';
import { githubWorkflow, newWorkflowUrl, repositoryName, workflowName } from './github-workflow';

describe('repositoryName', () => {
  it('accepts names and the URLs people paste', () => {
    for (const input of [
      'acme/api',
      ' acme/api ',
      'https://github.com/acme/api',
      'https://github.com/acme/api/',
      'github.com/acme/api.git',
      'git@github.com:acme/api.git',
    ])
      expect(repositoryName(input), input).toBe('acme/api');
    for (const input of ['acme', 'acme/api/tree/main', 'https://gitlab.com/acme/api', 'acme/..'])
      expect(repositoryName(input), input).toBeNull();
  });
});

describe('githubWorkflow', () => {
  it('requests an OpenID Connect token and quotes every value', () => {
    const workflow = githubWorkflow({
      stillupUrl: 'https://status.example.com/api',
      branch: 'main',
      environment: "prod's",
      config: 'monitoring/stillup.config.ts',
      cliVersion: '0.1.0',
    });
    expect(workflow).toContain('      id-token: write');
    expect(workflow).toContain("    environment: 'prod''s'");
    expect(workflow).toContain("    branches: ['main']");
    expect(workflow).toContain(
      "npx --yes @rec/stillup@0.1.0 apply --config 'monitoring/stillup.config.ts' --yes",
    );
    expect(workflow).toContain("STILLUP_URL: 'https://status.example.com/api'");
    expect(workflow).not.toMatch(/secrets\./);
  });
  it('omits the environment when none is required', () => {
    const workflow = githubWorkflow({
      stillupUrl: 'https://s.example.com/api',
      branch: null,
      environment: null,
      config: 'stillup.config.ts',
      cliVersion: '0.1.0',
    });
    expect(workflow).not.toContain('environment:');
    expect(workflow).toContain("branches: ['main']");
  });
});

describe('links', () => {
  it('prefills a new workflow file on GitHub', () => {
    const url = new URL(newWorkflowUrl('acme/api', 'release/1', 'monitoring.yml', 'name: x\n'));
    expect(url.pathname).toBe('/acme/api/new/release%2F1');
    expect(url.searchParams.get('filename')).toBe('.github/workflows/monitoring.yml');
    expect(url.searchParams.get('value')).toBe('name: x\n');
    expect(workflowName('.github/workflows/deploy.yml')).toBe('deploy.yml');
  });
});
