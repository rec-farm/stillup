import { z } from 'zod';
const webLink = z
  .union([
    z.literal(''),
    z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
      }, 'Use an HTTP(S) link without credentials'),
  ])
  .default('');
export const statusSettingsSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    brandName: z.string().trim().min(1).max(80).default('StillUp'),
    description: z.string().max(1000).default('A live look at the services you depend on.'),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#00856a'),
    logoUrl: webLink,
    homepageUrl: webLink,
    groups: z
      .array(
        z.object({
          id: z.uuid(),
          name: z.string().trim().min(1).max(80),
          monitorIds: z.array(z.uuid()).max(500),
        }),
      )
      .max(30)
      .default([]),
  })
  .superRefine((v, ctx) => {
    const ids = v.groups.flatMap((g) => g.monitorIds);
    if (
      new Set(ids).size !== ids.length ||
      new Set(v.groups.map((g) => g.id)).size !== v.groups.length
    )
      ctx.addIssue({ code: 'custom', message: 'Each component and group must appear only once' });
  });
export const maintenanceSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().max(4000).default(''),
    monitorIds: z.array(z.uuid()).max(500).default([]),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    cancelled: z.boolean().default(false),
  })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), 'End must be after start');
export const manualIncidentSchema = z.object({
  title: z.string().trim().min(1).max(160),
  monitorIds: z.array(z.uuid()).min(1).max(500),
  body: z.string().trim().min(1).max(4000),
});
export const statusUpdateSchema = z.object({
  source: z.enum(['automatic', 'manual']),
  stage: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
  body: z.string().trim().min(1).max(4000),
  expectedRevision: z.number().int().positive(),
});
export type StatusSettings = z.infer<typeof statusSettingsSchema>;
export type Maintenance = z.infer<typeof maintenanceSchema> & { id: string; revision: number };
export type StatusUpdate = {
  id: string;
  stage: z.infer<typeof statusUpdateSchema>['stage'];
  body: string;
  createdAt: string;
};
export type CommunicationIncident = {
  id: string;
  name: string;
  monitorIds: string[];
  source: 'automatic' | 'manual';
  openedAt: string;
  resolvedAt: string | null;
  revision: number;
  stage: StatusUpdate['stage'];
  updates: StatusUpdate[];
};
export type StatusManagement = {
  settings: StatusSettings;
  revision: number;
  maintenance: Maintenance[];
  incidents: CommunicationIncident[];
};
