import { format } from 'prettier';
import { writeFile, readFile } from 'node:fs/promises';
import { evaluateAssertions } from '../packages/core/src/assertions';
import { isPublicAddress } from '../packages/core/src/executor';
import { checkSchema } from '../packages/core/src/index';
const prettierConfig = JSON.parse(
  await readFile(new URL('../.prettierrc.json', import.meta.url), 'utf8'),
);
const writeFixture = async (path: URL, value: string) =>
  writeFile(path, await format(value, { ...prettierConfig, parser: 'json' }));
const base = { name: 'Example', url: 'https://example.com/health' };
const cases: { name: string; input: unknown }[] = [];
const add = (name: string, patch: Record<string, unknown>) =>
  cases.push({ name, input: { ...base, ...patch } });
add('defaults', {});
add('trim and discard unknown fields', { name: ' Example ', extra: 'ignored' });
add('all methods and routing', {
  method: 'POST',
  body: '{"ok":true}',
  headers: { Authorization: 'Bearer {{TOKEN}}' },
  intervalSeconds: 30,
  timeoutMs: 100,
  expectedStatus: 201,
  maxResponseMs: 30000,
  failureThreshold: 10,
  recoveryThreshold: 1,
  notificationChannelIds: ['12d5f625-8487-4400-ae00-9a3ee6616cc6'],
  locationIds: ['local'],
  locationFailureThreshold: 1,
  reminderIntervalSeconds: 300,
  public: true,
});
for (const [key, values] of Object.entries({
  method: ['OPTIONS', null],
  intervalSeconds: [29, 86401, 60.5, '60'],
  timeoutMs: [99, 30001],
  expectedStatus: [99, 600],
  maxResponseMs: [0, 30001],
  failureThreshold: [0, 11],
  public: ['true', null],
  body: ['x'],
}))
  for (const value of values) add(`${key} invalid ${String(value)}`, { [key]: value });
for (const url of [
  'ftp://example.com',
  'https://user:pass@example.com',
  'https://example.com/#x',
  'not-a-url',
])
  add(`invalid URL ${url}`, { url });
for (const headers of [
  { Bad: 'a\nb' },
  { 'Bad Header': 'x' },
  { okay: 3 },
  Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`x-${i}`, 'a'])),
])
  add('invalid headers ' + cases.length, { headers });
for (const operator of [
  'exists',
  'notExists',
  'equals',
  'notEquals',
  'contains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'length',
]) {
  const value = ['equals', 'notEquals'].includes(operator)
    ? null
    : ['contains', 'startsWith', 'endsWith'].includes(operator)
      ? 'ok'
      : ['gt', 'gte', 'lt', 'lte', 'length'].includes(operator)
        ? 2
        : undefined;
  add(`JSON operator ${operator}`, {
    jsonAssertions: [{ path: '$.items.0.id', operator, ...(value !== undefined ? { value } : {}) }],
  });
}
add('legacy equality', { jsonAssertions: [{ path: '$.ok', equals: true }] });
add('legacy unbounded path/value', {
  jsonAssertions: [{ path: '$.' + 'a'.repeat(300), equals: 'v'.repeat(4100) }],
});
for (const rule of [
  { path: '$..bad', operator: 'exists' },
  { path: '$.ok', operator: 'exists', value: true },
  { path: '$.ok', operator: 'gt', value: '3' },
  { path: '$.ok', equals: { a: 1 } },
  { path: '$.ok', operator: 'length', value: -1 },
])
  add('invalid JSON rule ' + cases.length, { jsonAssertions: [rule] });
for (const rule of [
  { name: 'x-test', operator: 'exists' },
  { name: 'x-test', operator: 'notExists' },
  { name: 'x-test', operator: 'equals', value: 'okay' },
  { name: 'x-test', operator: 'contains', value: 'okay' },
])
  add('header rule ' + cases.length, { headerAssertions: [rule] });
add('invalid header operator', {
  headerAssertions: [{ name: 'x-test', operator: 'gt', value: 1 }],
});
add('bounded schema', {
  responseSchema: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'integer', minimum: 0 } } },
    required: ['items'],
    additionalProperties: false,
  },
});
for (const responseSchema of [
  true,
  false,
  { $ref: 'https://evil.example/schema' },
  { pattern: 'x' },
  { required: ['x', 'x'] },
  { enum: [1, 1] },
  { properties: { x: { type: 'madeup' } } },
  { additionalProperties: {} },
  { minimum: '3' },
])
  add('schema ' + cases.length, { responseSchema });
add('location threshold too large', { locationIds: ['local'], locationFailureThreshold: 2 });
add('duplicate locations', { locationIds: ['local', 'local'] });
add('empty locations', { locationIds: [] });
add('duplicate channels', {
  notificationChannelIds: [
    '12d5f625-8487-4400-ae00-9a3ee6616cc6',
    '12d5f625-8487-4400-ae00-9a3ee6616cc6',
  ],
});
add('noncanonical UUID', { locationIds: ['12d5f62584874400ae009a3ee6616cc6'] });
add('long name', { name: 'a'.repeat(81) });
add('Unicode code point name length', { name: '🙂'.repeat(41) });
const results = cases.map(({ name, input }) => {
  let result;
  try {
    result = checkSchema.safeParse(input);
  } catch {
    return { name, input, accepted: false };
  }
  return {
    name,
    input,
    accepted: result.success,
    ...(result.success ? { normalized: result.data } : {}),
  };
});
await writeFixture(
  new URL('../backend/tests/fixtures/check-contracts.json', import.meta.url),
  JSON.stringify(results, null, 2) + '\n',
);
console.log(`Generated ${results.length} check contract fixtures`);

const assertionCases = [
  {
    name: 'all passing',
    patch: {
      expectedStatus: 200,
      maxResponseMs: 100,
      headerAssertions: [{ name: 'x-test', operator: 'contains', value: 'ok' }],
      jsonAssertions: [
        { path: '$.items.0.id', equals: 2 },
        { path: '$.items.length', operator: 'equals', value: 1 },
        { path: '$.missing', operator: 'notExists' },
      ],
      responseSchema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'integer', minimum: 0 } },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    status: 200,
    duration: 50,
    headers: { 'x-test': 'okay' },
    body: '{"items":[{"id":2}]}',
  },
  {
    name: 'status and response mismatch',
    patch: {
      maxResponseMs: 10,
      jsonAssertions: [
        { path: '$.ok', equals: true },
        { path: '$.missing', operator: 'equals', value: 3 },
      ],
      responseSchema: { type: 'object', required: ['ok'] },
    },
    status: 503,
    duration: 40,
    headers: {},
    body: '{}',
  },
  {
    name: 'invalid JSON',
    patch: { jsonAssertions: [{ path: '$', operator: 'exists' }], responseSchema: true },
    status: 200,
    duration: 1,
    headers: {},
    body: 'invalid',
  },
  {
    name: 'explicit false schema',
    patch: { responseSchema: false },
    status: 200,
    duration: 1,
    headers: {},
    body: '{}',
  },
  ...[
    'exists',
    'notExists',
    'equals',
    'notEquals',
    'contains',
    'startsWith',
    'endsWith',
    'gt',
    'gte',
    'lt',
    'lte',
    'length',
  ].flatMap((operator) =>
    [true, false].map((pass) => ({
      name: `operator ${operator} ${pass}`,
      patch: {
        jsonAssertions: [
          {
            path: '$.test',
            operator,
            ...(['exists', 'notExists'].includes(operator)
              ? {}
              : {
                  value:
                    operator === 'length'
                      ? 2
                      : ['contains', 'startsWith', 'endsWith'].includes(operator)
                        ? 'ok'
                        : ['gt', 'gte', 'lt', 'lte'].includes(operator)
                          ? 2
                          : true,
                }),
          },
        ],
      },
      status: 200,
      duration: 1,
      headers: {},
      body: JSON.stringify({
        test:
          operator === 'length'
            ? pass
              ? [1, 2]
              : []
            : ['contains', 'startsWith', 'endsWith'].includes(operator)
              ? pass
                ? 'okay'
                : 'bad'
              : ['gt', 'gte', 'lt', 'lte'].includes(operator)
                ? pass
                  ? 3
                  : 1
                : pass,
      }),
    })),
  ),
  ...[
    { type: 'number', minimum: 3 },
    { type: 'number', maximum: 0 },
    { type: 'string', minLength: 3 },
    { type: 'string', maxLength: 0 },
    { type: 'array', minItems: 3 },
    { type: 'array', maxItems: 0 },
    { enum: ['a'] },
    { type: 'object', required: ['missing'] },
    { type: 'object', additionalProperties: false },
  ].map((schema, i) => ({
    name: `schema keyword ${i}`,
    patch: { responseSchema: schema },
    status: 200,
    duration: 1,
    headers: {},
    body: JSON.stringify(
      schema.type === 'number'
        ? 2
        : schema.type === 'string'
          ? 'a'
          : schema.type === 'array'
            ? [1]
            : { extra: true },
    ),
  })),
];
await writeFixture(
  new URL('../backend/tests/fixtures/assertion-contracts.json', import.meta.url),
  JSON.stringify(
    assertionCases.map((c) => {
      const config = checkSchema.parse({ ...base, ...c.patch });
      return {
        ...c,
        config,
        expected: evaluateAssertions(config, c.status, c.duration, c.headers, c.body),
      };
    }),
    null,
    2,
  ) + '\n',
);
const addresses = [
  '8.8.8.8',
  '1.1.1.1',
  '10.0.0.1',
  '127.0.0.1',
  '100.64.0.1',
  '169.254.169.254',
  '192.0.2.1',
  '192.52.193.1',
  '192.175.48.1',
  '198.19.1.1',
  '203.0.113.1',
  '224.1.1.1',
  '255.255.255.255',
  '::1',
  '::',
  '::ffff:127.0.0.1',
  '::ffff:8.8.8.8',
  '2001:db8::1',
  '2001:4860:4860::8888',
  '64:ff9b::808:808',
  '64:ff9b:1::1',
  '2002::1',
  'fc00::1',
  'fe80::1',
  '3fff::1',
  '5f00::1',
  '2620:4f:8000::1',
];
await writeFixture(
  new URL('../backend/tests/fixtures/network-contracts.json', import.meta.url),
  JSON.stringify(
    addresses.map((address) => ({ address, public: isPublicAddress(address) })),
    null,
    2,
  ) + '\n',
);
