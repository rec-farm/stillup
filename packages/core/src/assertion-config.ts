import { z } from 'zod';

const scalar = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
const path = z
  .string()
  .max(256)
  .regex(/^\$(\.[A-Za-z0-9_-]+)*$/, 'Use a path such as $.status or $.items.0.id');
export const jsonAssertionSchema = z.union([
  z
    .object({
      path: z.string().regex(/^\$(\.[A-Za-z0-9_-]+)*$/),
      equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
  z.object({ path, operator: z.enum(['exists', 'notExists']) }).strict(),
  z.object({ path, operator: z.enum(['equals', 'notEquals']), value: scalar }).strict(),
  z
    .object({
      path,
      operator: z.enum(['contains', 'startsWith', 'endsWith']),
      value: z.string().max(4096),
    })
    .strict(),
  z.object({ path, operator: z.enum(['gt', 'gte', 'lt', 'lte']), value: z.number() }).strict(),
  z
    .object({ path, operator: z.literal('length'), value: z.number().int().min(0).max(1048576) })
    .strict(),
]);
export const headerAssertionSchema = z.union([
  z
    .object({
      name: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
      operator: z.enum(['exists', 'notExists']),
    })
    .strict(),
  z
    .object({
      name: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
      operator: z.enum(['equals', 'contains']),
      value: z.string().max(4096),
    })
    .strict(),
]);
export type JsonAssertion = z.infer<typeof jsonAssertionSchema>;
export type HeaderAssertion = z.infer<typeof headerAssertionSchema>;

// A bounded draft-07 subset: no references, regexes, or branching schemas.
// Validate structure before compiling on the worker; never execute schema code in the browser.
const nonnegative = z.number().int().min(0).max(1048576);
function schemaAt(depth: number): z.ZodType {
  if (depth > 8) return z.boolean();
  const child = schemaAt(depth + 1);
  return z.union([
    z.boolean(),
    z
      .object({
        type: z
          .enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
          .optional(),
        title: z.string().max(256).optional(),
        description: z.string().max(2048).optional(),
        properties: z.record(z.string().max(256), child).optional(),
        required: z
          .array(z.string().max(256))
          .max(100)
          .refine((v) => new Set(v).size === v.length, 'Required fields must be unique')
          .optional(),
        additionalProperties: z.boolean().optional(),
        items: child.optional(),
        enum: z
          .array(scalar)
          .min(1)
          .max(100)
          .refine(
            (v) => new Set(v.map((x) => JSON.stringify(x))).size === v.length,
            'Enum values must be unique',
          )
          .optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        minLength: nonnegative.optional(),
        maxLength: nonnegative.optional(),
        minItems: nonnegative.optional(),
        maxItems: nonnegative.optional(),
      })
      .strict(),
  ]);
}
export const responseSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (JSON.stringify(value)?.length > 16384)
      ctx.addIssue({ code: 'custom', message: 'Schema must be at most 16 KiB' });
  })
  .pipe(schemaAt(0));
export type AssertionResult = {
  kind: 'status' | 'latency' | 'header' | 'json' | 'schema';
  label: string;
  passed: boolean;
  message: string;
};
