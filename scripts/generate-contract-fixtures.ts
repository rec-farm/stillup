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

// Public status settings retain the saved pre-theme schema and browser contract.
const { statusSettingsSchema, maintenanceSchema } = await import('../packages/core/src/status');
const statusCases: { name: string; input: unknown }[] = [
  { name: 'saved legacy defaults', input: { title: 'Status' } },
  {
    name: 'normalized text and unknown fields',
    input: { title: ' Status ', brandName: ' Acme ', extra: true },
  },
  {
    name: 'custom appearance and content',
    input: {
      title: 'Status',
      theme: 'dark',
      layout: 'wide',
      font: 'mono',
      cornerRadius: 0,
      darkTextColor: '#ABCDEF',
      showPoweredBy: false,
      links: [{ label: ' Support ', url: 'https://example.com/#help' }],
      content: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          title: ' Help ',
          body: '<script>plain text</script>',
          position: 'before-services',
        },
      ],
      groups: [{ id: '00000000-0000-4000-8000-000000000002', name: ' Services ', monitorIds: [] }],
    },
  },
];
for (const [key, values] of Object.entries({
  title: [null, '', ' ', 1, '😀'.repeat(100), '😀'.repeat(101)],
  brandName: ['', null],
  description: ['x'.repeat(1001), null],
  cornerRadius: [-1, 33, 1.5, 16.0, '16'],
  theme: ['auto', 'system', null],
  font: ['serif', 'invalid'],
  layout: ['compact', 'invalid'],
  accentColor: ['#ABCDEF', '', '#fff'],
  darkTextColor: ['', 'white'],
  logoUrl: [
    'javascript:alert(1)',
    'https://user:secret@example.com',
    'http://example.com/image.png',
    '',
  ],
  showPoweredBy: [false, 'false', null],
  links: [
    Array(9).fill({ label: 'Link', url: 'https://example.com' }),
    [{ label: 'Bad', url: '' }],
  ],
  groups: [{}, [{ id: '00000000-0000-4000-8000-000000000002', name: 'Group' }]],
  content: [
    Array(13).fill({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Help',
      body: '',
      position: 'after-services',
    }),
  ],
})) {
  values.forEach((value, index) =>
    statusCases.push({ name: `${key} ${index}`, input: { title: 'Status', [key]: value } }),
  );
}
await writeFixture(
  new URL('../backend/tests/fixtures/status-contracts.json', import.meta.url),
  JSON.stringify(
    statusCases.map(({ name, input }) => {
      try {
        const result = statusSettingsSchema.safeParse(input);
        return {
          name,
          input,
          valid: result.success,
          ...(result.success ? { output: result.data } : {}),
        };
      } catch {
        return { name, input, valid: false };
      }
    }),
    null,
    2,
  ) + '\n',
);
const dates = [
  '2026-10-05T12:34:56Z',
  '2026-10-05T12:34:56+02:00',
  '2026-10-05T12:34:56.123456789123Z',
  '2026-10-05T12:34Z',
  '2026-10-05 12:34:56Z',
  '2026-10-05t12:34:56z',
  '2026-02-30T12:34:56Z',
  '2026-10-05T12:34:60Z',
  '2026-10-05T12:34:56+24:00',
];
await writeFixture(
  new URL('../backend/tests/fixtures/status-date-contracts.json', import.meta.url),
  JSON.stringify(
    dates.map((date) => ({
      date,
      valid: maintenanceSchema.shape.startsAt.safeParse(date).success,
    })),
    null,
    2,
  ) + '\n',
);

const { codeConfigSchema, canonicalJson } = await import('../packages/core/src/code-config');
const codeBase = { version: 1, project: 'production', checks: [{ id: 'api', config: base }] };
const codeCases = [
  codeBase,
  { ...codeBase, checks: [] },
  { ...codeBase, project: '../production' },
  { ...codeBase, prune: true },
  { ...codeBase, checks: [...codeBase.checks, ...codeBase.checks] },
  { ...codeBase, checks: [{ id: 'api', config: { ...base, intervalseconds: 30 } }] },
  {
    ...codeBase,
    checks: [
      {
        id: 'api',
        config: {
          ...base,
          headers: { Authorization: '{{TOKEN}}' },
          jsonAssertions: [{ path: '$.size', equals: 1e21 }],
        },
      },
    ],
  },
];
await writeFixture(
  new URL('../backend/tests/fixtures/code-contracts.json', import.meta.url),
  JSON.stringify(
    codeCases.map((input) => {
      const result = codeConfigSchema.safeParse(input);
      return { input, valid: result.success, ...(result.success ? { output: result.data } : {}) };
    }),
    null,
    2,
  ) + '\n',
);
const canonicalCases = [
  null,
  false,
  ['A', 'a', 1.0, -0, 1e-7, 1e-6, 1e20, 1e21],
  { Z: 1, a: 2, A: 3, _: 4, '-': 5, é: 6, é: 7, '😀': 8, '10': 9, '2': 10 },
  { schema: { properties: { あ: true, Á: { enum: [null, 1e21, 'quoted\ntext'] }, a: false } } },
  { Accept: 'json', Authorization: '{{TOKEN}}', 'x-token': 'fixture' },
];
await writeFixture(
  new URL('../backend/tests/fixtures/canonical-contracts.json', import.meta.url),
  JSON.stringify(
    canonicalCases.map((input) => ({ input, canonical: canonicalJson(input) })),
    null,
    2,
  ) + '\n',
);

// Original HTTP route coercion contract (the same validator used by legacy server.ts).
const { z } = await import('../tests/legacy-api/node_modules/zod/index.js');
const positiveInteger = z.coerce.number().int().positive();
const integerInputs = [
  '1',
  '01',
  '+1',
  '1.0',
  '1.',
  '.1e1',
  '1e2',
  '1E+2',
  '0x10',
  '0X10',
  '0b10',
  '0B10',
  '0o10',
  '0O10',
  '2147483648',
  '9007199254740991',
  '9007199254740992',
  '9007199254740990.9',
  '0',
  '-0',
  '-1',
  '',
  ' ',
  'NaN',
  'Infinity',
  '+Infinity',
  'inf',
  '1.2',
  '1_0',
  '+0x1',
  '-0x1',
  '0x',
  '0x+1',
  '0b+1',
  '0o+1',
  '0b2',
  '0o8',
  '1e',
  '1foo',
  '1\u0085',
  '\ufeff1',
  '\u00a01\u2029',
  '\u20001\u3000',
];
await writeFixture(
  new URL('../backend/tests/fixtures/route-integer-contracts.json', import.meta.url),
  JSON.stringify(
    integerInputs.map((input) => {
      const result = positiveInteger.safeParse(input);
      return { input, valid: result.success, ...(result.success ? { output: result.data } : {}) };
    }),
    null,
    2,
  ) + '\n',
);
