import { z } from 'zod';
export const webhookUrlSchema = z
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  }, 'Use an HTTP(S) URL without embedded credentials or a fragment');
export const channelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: webhookUrlSchema,
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
export const channelEditSchema = channelSchema.omit({ url: true }).extend({
  url: webhookUrlSchema.optional(),
  expectedRevision: z.number().int().positive(),
});
export type Channel = {
  id: string;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  revision: number;
  source: 'environment' | 'database';
  destination: string;
  createdAt: string;
};
export type AlertEvent = {
  id: string;
  type: 'incident.opened' | 'incident.resolved' | 'incident.reminder' | 'notification.test';
  name: string;
  at: string;
  monitorId?: string;
  runId?: string;
  configRevision?: number;
};
export type Delivery = {
  id: string;
  channelId: string;
  channelName: string;
  incidentId: string | null;
  event: AlertEvent;
  status: 'pending' | 'delivering' | 'retrying' | 'delivered' | 'failed' | 'cancelled';
  attempts: number;
  cycleAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
};
export type DeliveryAttempt = {
  id: string;
  number: number;
  startedAt: string;
  finishedAt: string | null;
  statusCode: number | null;
  error: string | null;
};
export type DeliveryPage = { deliveries: Delivery[]; nextBefore: string | null };
