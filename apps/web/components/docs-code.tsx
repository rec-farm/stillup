import 'server-only';
import { codeToTokens, type BundledLanguage } from 'shiki';
import { DocsCopyButton } from './docs-copy-button';
import { FileCode2, Terminal } from 'lucide-react';

const languages: Record<string, BundledLanguage> = {
  shell: 'bash',
  env: 'dotenv',
  typescript: 'typescript',
  javascript: 'javascript',
  json: 'json',
};
export async function DocsCode({
  code,
  language,
  title,
}: {
  code: string;
  language?: string;
  title?: string;
}) {
  const { tokens } = await codeToTokens(code, {
    lang: languages[language ?? ''] ?? 'text',
    theme: 'github-dark',
  });
  const Icon = language === 'shell' ? Terminal : FileCode2;
  return (
    <div className="docs-code">
      <div className="docs-code-bar">
        <span className="docs-code-title">
          <Icon size={15} aria-hidden="true" />
          {title ?? (language === 'shell' ? 'Terminal' : language === 'env' ? '.env' : 'Example')}
        </span>
        <span className="docs-code-language">{language ?? 'text'}</span>
        <DocsCopyButton code={code} />
      </div>
      <pre tabIndex={0} aria-label={`${title ?? language ?? 'Code'} example`}>
        <code>
          {tokens.map((line, index) => (
            <span className="docs-code-line" key={index}>
              <span className="docs-line-number" aria-hidden="true">
                {index + 1}
              </span>
              <span>
                {line.map((token, i) => (
                  <span key={i} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
                {index < tokens.length - 1 ? '\n' : ''}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
