import { z } from 'zod';
import { checkSchema, type CheckConfig } from './index';

export const codeIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,63}$/,
    'Use 1–64 lowercase letters, digits, or hyphens, starting with a letter',
  );
export const codeConfigSchema = z
  .strictObject({
    version: z.literal(1),
    project: codeIdSchema,
    checks: z.array(z.strictObject({ id: codeIdSchema, config: checkSchema.strict() })).max(100),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.checks.forEach((check, index) => {
      if (ids.has(check.id))
        ctx.addIssue({
          code: 'custom',
          path: ['checks', index, 'id'],
          message: 'Check IDs must be unique within a project',
        });
      ids.add(check.id);
    });
  });
export type CodeConfigInput = z.input<typeof codeConfigSchema>;
export type CodeConfig = z.output<typeof codeConfigSchema>;
export type CodePlan = {
  project: string;
  token: string;
  changes: {
    id: string;
    action: 'create' | 'update' | 'unchanged' | 'retained';
    fields: string[];
    monitorId?: string;
    revision?: number;
    paused?: boolean;
    archived?: boolean;
  }[];
};

// Compare JSON structurally: object property order must not create revisions or stale plans.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function changedConfigFields(before: CheckConfig, after: CheckConfig): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter(
      (key) =>
        canonicalJson(before[key as keyof CheckConfig]) !==
        canonicalJson(after[key as keyof CheckConfig]),
    );
}
