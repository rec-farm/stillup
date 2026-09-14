import { createService } from './service';
const service = await createService();
const stop = await service.startWorker();
console.log('StillUp HTTP worker started');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await stop();
    await service.close();
    process.exit(0);
  });
