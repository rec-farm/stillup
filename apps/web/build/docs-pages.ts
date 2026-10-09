import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { docs, type Doc } from '../lib/docs.ts';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
const paragraphs = (items: string[] = []) => items.map((item) => `<p>${escape(item)}</p>`).join('');
const code = (value: string) => `<pre><code>${escape(value)}</code></pre>`;
const table = (headers: string[], rows: string[][]) =>
  `<div class="docs-table-wrap"><table><thead><tr>${headers.map((header) => `<th scope="col">${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
function article(doc: Doc) {
  return `<article class="docs-article"><h1>${escape(doc.title)}</h1><p>${escape(doc.description)}</p>${doc.sections
    .map(
      (section) =>
        `<section id="${escape(section.id)}"><h2>${escape(section.title)}</h2>${paragraphs(section.paragraphs)}${section.steps ? `<ol>${section.steps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol>` : ''}${section.callout ? `<aside><h3>${escape(section.callout.title)}</h3><p>${escape(section.callout.body)}</p></aside>` : ''}${section.code ? code(section.code) : ''}${section.examples?.map((example) => `<h3>${escape(example.title)}</h3>${code(example.code)}`).join('') ?? ''}${
          section.endpoints
            ? table(
                ['Method', 'Endpoint', 'Description'],
                section.endpoints.map((endpoint) => [
                  endpoint.method,
                  endpoint.path,
                  endpoint.description,
                ]),
              )
            : ''
        }${
          section.fields
            ? table(
                section.fieldColumns ?? ['Field', 'Default', 'Description'],
                section.fields.map((field) => [field.name, field.default, field.description]),
              )
            : ''
        }</section>`,
    )
    .join('')}</article>`;
}

// Static prose is available before JavaScript and remains readable when it is disabled.
// The same canonical guide data drives the interactive React documentation.
export function docsPages(): Plugin {
  let directory = '';
  return {
    name: 'stillup-docs-pages',
    apply: 'build',
    configResolved(config) {
      directory = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const template = await readFile(resolve(directory, 'index.html'), 'utf8');
      const navigation = `<nav aria-label="Documentation"><a href="/docs">Documentation home</a><ul>${docs.map((doc) => `<li><a href="/docs/${escape(doc.slug)}">${escape(doc.title)}</a></li>`).join('')}</ul></nav>`;
      const pages = [
        {
          slug: '',
          title: 'StillUp documentation',
          description: 'Guides and API reference for monitoring with StillUp.',
          content: `<h1>StillUp documentation</h1><p>Guides and API reference for monitoring with StillUp.</p>${docs.map((doc) => `<section><h2><a href="/docs/${escape(doc.slug)}">${escape(doc.title)}</a></h2><p>${escape(doc.description)}</p></section>`).join('')}`,
        },
        ...docs.map((doc) => ({ ...doc, content: article(doc) })),
      ];
      for (const page of pages) {
        const html = template
          .replace(/<title>[^<]*<\/title>/, `<title>${escape(page.title)} · StillUp</title>`)
          .replace(
            /<meta name="description" content="[^"]*"\s*\/>/,
            `<meta name="description" content="${escape(page.description)}" />`,
          )
          .replace(
            '<div id="root"></div>',
            `<div id="root" data-prerendered="docs"><main class="docs-static"><a href="/">StillUp</a>${navigation}${page.content}</main></div>`,
          )
          .replace(
            'StillUp requires JavaScript to display live monitoring data.',
            'This guide is readable without JavaScript. Enable JavaScript for search and copy controls.',
          )
          .replace(
            '</head>',
            '<style>.docs-static{max-width:72rem;margin:auto;padding:2rem;line-height:1.7}.docs-static nav ul{display:flex;flex-wrap:wrap;gap:1rem;list-style:none;padding:0}.docs-static article{max-width:52rem}.docs-static pre,.docs-table-wrap{overflow:auto}.docs-static pre{padding:1rem;background:var(--surface,#17201c);border-radius:.5rem}.docs-static section{margin-block:2rem}.docs-static th,.docs-static td{padding:.5rem;text-align:left;vertical-align:top}</style></head>',
          );
        const target = resolve(directory, 'docs', page.slug);
        await mkdir(target, { recursive: true });
        await writeFile(resolve(target, 'index.html'), html);
      }
    },
  };
}
