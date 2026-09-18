/** Small, explicit inline-code syntax. Text always stays React-escaped. */
export function DocsInline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, index) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code className="docs-inline-code" key={index}>
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
