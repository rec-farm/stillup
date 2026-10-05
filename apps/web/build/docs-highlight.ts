import type { Plugin } from 'vite';
import { codeToTokens, type BundledLanguage } from 'shiki';
import { docs } from '../lib/docs.ts';

// Highlight while building, retaining the docs' dual themes without shipping Shiki/WASM.
export function docsHighlight(): Plugin {
  const id = '\0virtual:docs-highlight';
  const languages: Record<string, BundledLanguage> = {
    shell: 'bash',
    env: 'dotenv',
    typescript: 'typescript',
    javascript: 'javascript',
    json: 'json',
  };
  return {
    name: 'stillup-docs-highlight',
    resolveId(source) {
      if (source === 'virtual:docs-highlight') return id;
    },
    async load(source) {
      if (source !== id) return;
      const result: Record<string, unknown> = {};
      for (const doc of docs)
        for (const section of doc.sections) {
          const examples = [
            ...(section.code ? [{ code: section.code, language: section.language }] : []),
            ...(section.examples ?? []),
          ];
          for (const example of examples) {
            const key = JSON.stringify([example.code, example.language ?? '']);
            if (result[key]) continue;
            const { tokens } = await codeToTokens(example.code, {
              lang: languages[example.language ?? ''] ?? 'text',
              themes: { dark: 'github-dark', light: 'github-light' },
              defaultColor: false,
            });
            result[key] = tokens.map((line) =>
              line.map((token) => ({ content: token.content, style: token.htmlStyle })),
            );
          }
        }
      return `export default ${JSON.stringify(result)}`;
    },
  };
}
