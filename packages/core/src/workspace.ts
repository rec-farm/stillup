import { z } from 'zod';

export const workspaceSettingsSchema = z.object({
  name: z.string().trim().min(1).max(60).default('StillUp'),
  tagline: z.string().trim().max(160).default('A little peace of mind for everything you build.'),
  logoUrl: z
    .string()
    .max(2048)
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        return false;
      }
    }, 'Use a public HTTPS image URL without credentials')
    .default(''),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color')
    .default('#087f67'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type WorkspaceAppearance = { settings: WorkspaceSettings; revision: number };
export const defaultWorkspaceSettings = workspaceSettingsSchema.parse({});
