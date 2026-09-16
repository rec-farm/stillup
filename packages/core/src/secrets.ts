import { z } from 'zod';
export const secretNameSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{0,79}$/,
    'Use uppercase letters, digits, and underscores; start with a letter',
  );
export const secretCreateSchema = z.object({
  name: secretNameSchema,
  value: z.string().min(1).max(65536),
  enabled: z.boolean().default(true),
});
export const secretEditSchema = z.object({
  value: z.string().min(1).max(65536).optional(),
  enabled: z.boolean(),
  expectedRevision: z.number().int().positive(),
});
export function secretReferences(values: string[]): string[] {
  return [
    ...new Set(
      values.flatMap((value) =>
        [...value.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)].map((match) => match[1]!),
      ),
    ),
  ];
}
export type SecretUsage = {
  kind: 'check' | 'channel' | 'delivery';
  id: string;
  name: string;
  archived?: boolean;
};
export type SecretMetadata = {
  name: string;
  source: 'database' | 'environment' | 'missing';
  enabled: boolean;
  revision: number | null;
  updatedAt: string | null;
  usages: SecretUsage[];
};
export type SecretOverview = { encryptionConfigured: boolean; secrets: SecretMetadata[] };
