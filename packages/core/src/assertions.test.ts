import { describe, expect, it } from 'vitest';
import { checkSchema } from './index';
import { evaluateAssertions } from './assertions';
const evaluate = (
  extra: object,
  body: unknown = { status: 'healthy', count: 3, list: [1, 2], nullable: null },
) =>
  evaluateAssertions(
    checkSchema.parse({ name: 'test', url: 'https://example.com', ...extra }),
    200,
    10,
    { 'content-type': 'application/json', 'set-cookie': ['secret=private', 'token=private'] },
    JSON.stringify(body),
  );
describe('API contract assertions', () => {
  it.each([
    ['exists', '$.nullable', undefined, true],
    ['notExists', '$.absent', undefined, true],
    ['exists', '$.toString', undefined, false],
    ['equals', '$.count', 3, true],
    ['equals', '$.count', '3', false],
    ['notEquals', '$.absent', 3, false],
    ['notEquals', '$.count', 2, true],
    ['contains', '$.status', 'alth', true],
    ['startsWith', '$.status', 'hea', true],
    ['endsWith', '$.status', 'thy', true],
    ['gt', '$.count', 2, true],
    ['gte', '$.count', 3, true],
    ['lt', '$.count', 3, false],
    ['lte', '$.count', 3, true],
    ['length', '$.list', 2, true],
    ['length', '$.status', 7, false],
    ['gt', '$.status', 0, false],
    ['equals', '$.list.1', 2, true],
  ])('%s at %s is type strict', (operator, path, value, passed) => {
    expect(
      evaluate({
        jsonAssertions: [{ operator, path, ...(value === undefined ? {} : { value }) }],
      }).at(-1)?.passed,
    ).toBe(passed);
  });
  it('compares header names without case sensitivity and never persists values', () => {
    const results = evaluate({
      headerAssertions: [
        { name: 'Content-Type', operator: 'contains', value: 'json' },
        { name: 'missing', operator: 'notExists' },
        { name: 'Set-Cookie', operator: 'equals', value: 'wrong-secret' },
      ],
    });
    expect(results.map((r) => r.passed)).toEqual([true, true, true, false]);
    expect(JSON.stringify(results)).not.toMatch(/private|wrong-secret/);
  });
  it('validates required fields, nested arrays, types, bounds and extra fields', () => {
    const responseSchema = {
      type: 'object',
      required: ['items'],
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'integer', minimum: 1 } },
          },
        },
      },
    };
    expect(evaluate({ responseSchema }, { items: [{ id: 2 }] }).at(-1)?.passed).toBe(true);
    for (const body of [
      {},
      { items: [] },
      { items: [{ id: '2' }] },
      { items: [{ id: 0 }] },
      { items: [{}] },
      { items: [{ id: 2 }], 'private-field': 'secret' },
    ]) {
      const results = evaluate({ responseSchema }, body);
      expect(results.at(-1)?.passed).toBe(false);
      expect(JSON.stringify(results)).not.toMatch(/private-field|secret/);
    }
  });
  it('supports boolean schemas and does not coerce or mutate response values', () => {
    expect(evaluate({ responseSchema: false }).at(-1)?.passed).toBe(false);
    expect(evaluate({ responseSchema: true }).at(-1)?.passed).toBe(true);
    expect(evaluate({ responseSchema: { type: 'integer' } }, '3').at(-1)?.passed).toBe(false);
  });
  it('fails every JSON-dependent rule on invalid JSON, including absence checks', () => {
    const config = checkSchema.parse({
      name: 'test',
      url: 'https://example.com',
      jsonAssertions: [{ path: '$.missing', operator: 'notExists' }],
      responseSchema: true,
    });
    const results = evaluateAssertions(config, 200, 1, {}, 'not json');
    expect(results.slice(1).map((r) => r.passed)).toEqual([false, false]);
  });
  it.each([
    { pattern: '(a+)+' },
    { $ref: 'https://example.com/schema' },
    { type: 'bogus' },
    { required: ['a', 'a'] },
    { enum: [1, 1] },
    { minItems: -1 },
    { description: 'x'.repeat(17000) },
  ])('rejects unsupported or invalid schemas: %j', (responseSchema) => {
    expect(
      checkSchema.safeParse({ name: 'test', url: 'https://example.com', responseSchema }).success,
    ).toBe(false);
  });
  it('bounds nesting and rule counts', () => {
    let schema: object = { type: 'string' };
    for (let i = 0; i < 10; i++) schema = { items: schema };
    expect(
      checkSchema.safeParse({ name: 'test', url: 'https://example.com', responseSchema: schema })
        .success,
    ).toBe(false);
    expect(
      checkSchema.safeParse({
        name: 'test',
        url: 'https://example.com',
        headerAssertions: Array(21).fill({ name: 'x', operator: 'exists' }),
      }).success,
    ).toBe(false);
  });
});
