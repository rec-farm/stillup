import { z } from 'zod';
export const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    ADMIN_TOKEN: z.string().min(32),
    APP_ORIGIN: z.url().default('http://localhost:3000'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().default(3001),
    ALLOW_PRIVATE_NETWORKS: z.enum(['true', 'false']).default('false'),
    STATUS_PAGE_TITLE: z.string().default('Service status'),
    ALERT_WEBHOOK_URL: z.union([z.literal(''), z.url()]).default(''),
    RUN_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  })
  .parse(process.env);
