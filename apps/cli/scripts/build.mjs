import ts from 'typescript';
import { copyFile, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(packageDir, '../..');
const outDir = resolve(packageDir, 'dist');
const config = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
// TypeScript resolves workspace package imports through node_modules and treats
// them as external libraries, which are checked but not emitted. Explicit roots
// ensure the published package contains their implementations and declarations.
const workspaceModules = {
  '@stillup/sdk': 'packages/sdk/src/index',
  '@stillup/core': 'packages/core/src/index',
  '@stillup/core/code-config': 'packages/core/src/code-config',
};
const program = ts.createProgram(
  [
    resolve(packageDir, 'src/main.ts'),
    ...Object.values(workspaceModules).map((path) => resolve(root, `${path}.ts`)),
  ],
  {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    rootDir: root,
    outDir,
    types: ['node'],
  },
);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n',
    }),
  );
}

// Ship the SDK and its schema modules inside this package. Consumers need no
// unpublished workspace packages; rewrite imports in both JS and declarations.
await rm(outDir, { recursive: true, force: true });
const writes = [];
const result = program.emit(undefined, (filename, contents) => {
  const rewritten = contents.replace(
    /((?:from\s*|import\s*|import\(\s*)['"])([^'"]+)(['"])/g,
    (match, before, specifier, after) => {
      let target = specifier;
      if (workspaceModules[specifier]) {
        target = relative(dirname(filename), resolve(outDir, workspaceModules[specifier]))
          .split(sep)
          .join('/');
        if (!target.startsWith('.')) target = `./${target}`;
      }
      if (target.startsWith('.') && !/\.[cm]?js$/.test(target)) target += '.js';
      return `${before}${target}${after}`;
    },
  );
  writes.push(
    (async () => {
      await mkdir(dirname(filename), { recursive: true });
      await writeFile(filename, rewritten);
    })(),
  );
});
await Promise.all(writes);
if (result.emitSkipped) throw new Error('TypeScript did not emit the package.');
await writeFile(
  resolve(outDir, 'cli.js'),
  '#!/usr/bin/env node\nimport "./apps/cli/src/main.js";\n',
);
await chmod(resolve(outDir, 'cli.js'), 0o755);
await copyFile(resolve(root, 'LICENSE'), resolve(packageDir, 'LICENSE'));
console.log('Built @rec/stillup with CLI, SDK, and TypeScript declarations.');
