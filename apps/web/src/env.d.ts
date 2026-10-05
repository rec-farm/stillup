declare module 'virtual:docs-highlight' {
  const tokens: Record<string, { content: string; style?: import('react').CSSProperties }[][]>;
  export default tokens;
}
