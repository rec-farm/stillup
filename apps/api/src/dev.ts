import { createService } from './service';
import { createServer } from './server';
import { env } from './env';
const service = await createService();
const stopWorker = await service.startWorker();
const app = await createServer(service);
await app.listen({ port: env.PORT, host: env.HOST });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await stopWorker();
    await service.close();
    process.exit(0);
  });
