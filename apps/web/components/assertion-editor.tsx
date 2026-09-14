'use client';
import { useState } from 'react';
import type { JsonAssertion, HeaderAssertion } from '@stillup/core';

type Row = {
  id: number;
  legacyEquals: boolean;
  target: string;
  operator: string;
  type: string;
  value: string;
};
const labels: Record<string, string> = {
  equals: 'Equals',
  notEquals: 'Does not equal',
  exists: 'Exists',
  notExists: 'Does not exist',
  contains: 'Contains',
  startsWith: 'Starts with',
  endsWith: 'Ends with',
  gt: 'Greater than',
  gte: 'At least',
  lt: 'Less than',
  lte: 'At most',
  length: 'Array length',
};
export function AssertionEditor({
  kind,
  initial = [],
}: {
  kind: 'json' | 'header';
  initial?: (JsonAssertion | HeaderAssertion)[];
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((rule, id) => {
      const value = 'equals' in rule ? rule.equals : 'value' in rule ? rule.value : '';
      return {
        id,
        legacyEquals: 'equals' in rule,
        target: 'path' in rule ? rule.path : rule.name,
        operator: 'equals' in rule ? 'equals' : rule.operator,
        type: value === null ? 'null' : typeof value,
        value: value === null ? '' : String(value),
      };
    }),
  );
  const [nextId, setNextId] = useState(initial.length);
  const update = (id: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const rules = rows.map((row) => {
    const base = kind === 'json' ? { path: row.target } : { name: row.target };
    if (['exists', 'notExists'].includes(row.operator)) return { ...base, operator: row.operator };
    const numeric = ['gt', 'gte', 'lt', 'lte', 'length'].includes(row.operator);
    const typed = kind === 'json' && ['equals', 'notEquals'].includes(row.operator);
    const value =
      numeric || (typed && row.type === 'number')
        ? row.value.trim() && Number.isFinite(Number(row.value))
          ? Number(row.value)
          : { invalidNumber: true }
        : typed && row.type === 'boolean'
          ? row.value === 'true'
          : typed && row.type === 'null'
            ? null
            : row.value;
    // Preserve the original equality representation for revision compatibility.
    return kind === 'json' && row.operator === 'equals' && row.legacyEquals
      ? { ...base, equals: value }
      : { ...base, operator: row.operator, value };
  });
  return (
    <section
      className="assertion-editor"
      aria-label={`${kind === 'json' ? 'JSON' : 'Header'} assertions`}
    >
      <h4>{kind === 'json' ? 'JSON fields' : 'Response headers'}</h4>
      <p className="field-hint">
        {kind === 'json'
          ? 'Use dot paths such as $.status or $.items.0.id. Comparisons require the selected type.'
          : 'Header names are case insensitive. Values are compared exactly as text.'}
      </p>
      <input
        type="hidden"
        name={kind === 'json' ? 'assertions' : 'headerAssertions'}
        value={JSON.stringify(rules)}
      />
      {rows.map((row, index) => {
        const prefix = `${kind}-${row.id}`;
        const noValue = ['exists', 'notExists'].includes(row.operator);
        const typed = kind === 'json' && ['equals', 'notEquals'].includes(row.operator);
        const numeric =
          ['gt', 'gte', 'lt', 'lte', 'length'].includes(row.operator) ||
          (typed && row.type === 'number');
        return (
          <fieldset className="assertion-row" key={row.id}>
            <legend>Rule {index + 1}</legend>
            <label htmlFor={`${prefix}-target`}>
              {kind === 'json' ? 'JSON path' : 'Header name'}
            </label>
            <input
              id={`${prefix}-target`}
              value={row.target}
              required
              maxLength={256}
              placeholder={kind === 'json' ? '$.status' : 'content-type'}
              onChange={(e) => update(row.id, { target: e.target.value })}
            />
            <div className="form-grid">
              <div>
                <label htmlFor={`${prefix}-operator`}>Condition</label>
                <select
                  id={`${prefix}-operator`}
                  value={row.operator}
                  onChange={(e) => update(row.id, { operator: e.target.value })}
                >
                  {(kind === 'json'
                    ? Object.keys(labels)
                    : ['exists', 'notExists', 'equals', 'contains']
                  ).map((op) => (
                    <option key={op} value={op}>
                      {labels[op]}
                    </option>
                  ))}
                </select>
              </div>
              {typed && (
                <div>
                  <label htmlFor={`${prefix}-type`}>Value type</label>
                  <select
                    id={`${prefix}-type`}
                    value={row.type}
                    onChange={(e) =>
                      update(row.id, {
                        type: e.target.value,
                        value: e.target.value === 'boolean' ? 'true' : '',
                      })
                    }
                  >
                    {['string', 'number', 'boolean', 'null'].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {!noValue && !(typed && row.type === 'null') && (
              <>
                <label htmlFor={`${prefix}-value`}>Expected value</label>
                {typed && row.type === 'boolean' ? (
                  <select
                    id={`${prefix}-value`}
                    value={row.value}
                    onChange={(e) => update(row.id, { value: e.target.value })}
                  >
                    <option>true</option>
                    <option>false</option>
                  </select>
                ) : (
                  <input
                    id={`${prefix}-value`}
                    type={numeric ? 'number' : 'text'}
                    step={row.operator === 'length' ? '1' : 'any'}
                    min={row.operator === 'length' ? 0 : undefined}
                    required={numeric}
                    maxLength={4096}
                    value={row.value}
                    onChange={(e) => update(row.id, { value: e.target.value })}
                  />
                )}
              </>
            )}
            <button
              type="button"
              className="button secondary"
              aria-label={`Remove ${kind} rule ${index + 1}`}
              onClick={() => setRows((current) => current.filter((r) => r.id !== row.id))}
            >
              Remove rule
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="button secondary"
        disabled={rows.length >= 20}
        onClick={() => {
          setRows((current) => [
            ...current,
            {
              id: nextId,
              legacyEquals: true,
              target: kind === 'json' ? '$.' : '',
              operator: 'exists',
              type: 'string',
              value: '',
            },
          ]);
          setNextId((id) => id + 1);
        }}
      >
        Add {kind === 'json' ? 'JSON' : 'header'} rule
      </button>
    </section>
  );
}
