import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { CheckConfig, AssertionResult, JsonAssertion } from './index';

const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true, addUsedSchema: false });
const validators = new Map<string, ValidateFunction>();
export function schemaValidator(schema: object | boolean) {
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    if (typeof schema === 'object') ajv.removeSchema(schema);
    if (validators.size >= 100) validators.delete(validators.keys().next().value!);
    validators.set(key, validate);
  }
  return validate;
}
function matches(rule: JsonAssertion, value: unknown): boolean {
  if ('equals' in rule) return value === rule.equals;
  switch (rule.operator) {
    case 'exists':
      return value !== undefined;
    case 'notExists':
      return value === undefined;
    case 'equals':
      return value === rule.value;
    case 'notEquals':
      return value !== undefined && value !== rule.value;
    case 'contains':
      return typeof value === 'string' && value.includes(rule.value);
    case 'startsWith':
      return typeof value === 'string' && value.startsWith(rule.value);
    case 'endsWith':
      return typeof value === 'string' && value.endsWith(rule.value);
    case 'gt':
      return typeof value === 'number' && value > rule.value;
    case 'gte':
      return typeof value === 'number' && value >= rule.value;
    case 'lt':
      return typeof value === 'number' && value < rule.value;
    case 'lte':
      return typeof value === 'number' && value <= rule.value;
    case 'length':
      return Array.isArray(value) && value.length === rule.value;
  }
}
function mismatch(rule: JsonAssertion, value: unknown): string {
  if (value === undefined) return 'Field is missing';
  const operator = 'equals' in rule ? 'equals' : rule.operator;
  if (operator === 'notExists') return 'Field exists';
  if (operator === 'length')
    return Array.isArray(value) ? 'Array length did not match' : 'Expected an array';
  const expected = 'equals' in rule ? rule.equals : 'value' in rule ? rule.value : undefined;
  if (expected === null ? value !== null : typeof value !== typeof expected)
    return 'Field has the wrong type';
  return 'Value did not match the condition';
}
export function evaluateAssertions(
  config: CheckConfig,
  status: number,
  duration: number,
  headers: Record<string, string | string[] | undefined>,
  body: string,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  const add = (kind: AssertionResult['kind'], label: string, passed: boolean, failure: string) =>
    results.push({ kind, label, passed, message: passed ? 'Passed' : failure });
  add(
    'status',
    'HTTP status',
    status === config.expectedStatus,
    `Expected HTTP ${config.expectedStatus}, received ${status}`,
  );
  if (config.maxResponseMs !== null)
    add(
      'latency',
      'Response time',
      duration <= config.maxResponseMs,
      `Response exceeded ${config.maxResponseMs} ms`,
    );
  for (const rule of config.headerAssertions ?? []) {
    const raw = headers[rule.name.toLowerCase()];
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    const passed =
      rule.operator === 'exists'
        ? value !== undefined
        : rule.operator === 'notExists'
          ? value === undefined
          : rule.operator === 'equals'
            ? value === rule.value
            : 'value' in rule && value?.includes(rule.value) === true;
    add(
      'header',
      `${rule.name} · ${rule.operator}`,
      passed,
      `Header assertion failed: ${value === undefined ? 'Header is missing' : rule.operator === 'notExists' ? 'Header exists' : 'Value did not match the condition'}`,
    );
  }
  if (config.jsonAssertions.length || config.responseSchema !== undefined) {
    let json: unknown;
    let valid = true;
    try {
      json = JSON.parse(body);
    } catch {
      valid = false;
    }
    for (const rule of config.jsonAssertions) {
      let value = json;
      for (const key of rule.path.split('.').slice(1))
        value =
          value !== null && typeof value === 'object' && Object.hasOwn(value, key)
            ? (value as Record<string, unknown>)[key]
            : undefined;
      const operator = 'equals' in rule ? 'equals' : rule.operator;
      add(
        'json',
        `${rule.path} · ${operator}`,
        valid && matches(rule, value),
        valid
          ? `JSON assertion failed at ${rule.path}: ${mismatch(rule, value)}`
          : 'Response is not valid JSON',
      );
    }
    if (config.responseSchema !== undefined) {
      const validate = schemaValidator(config.responseSchema as object | boolean);
      const passed = valid && validate(json) === true;
      // Never persist AJV instance paths or params: these can contain response property names/data.
      const keyword = validate.errors?.[0]?.keyword;
      add(
        'schema',
        'JSON Schema',
        passed,
        valid
          ? `JSON Schema validation failed${keyword ? ` (${keyword})` : ''}`
          : 'Response is not valid JSON',
      );
    }
  }
  return results;
}
