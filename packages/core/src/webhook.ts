import { request } from 'undici';
import { createRequestAgent, validateNetworkTarget } from './executor';
import { webhookUrlSchema } from './notifications';
export async function sendWebhook(
  target: string,
  payload: object,
  deliveryId: string,
  allowPrivateNetworks = false,
): Promise<{ statusCode: number | null; error: string | null }> {
  const agent = createRequestAgent(allowPrivateNetworks);
  try {
    const url = new URL(webhookUrlSchema.parse(target));
    validateNetworkTarget(url, allowPrivateNetworks);
    const response = await request(url, {
      method: 'POST',
      dispatcher: agent,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'StillUp/0.1',
        'idempotency-key': deliveryId,
      },
      body: JSON.stringify({ ...payload, eventId: deliveryId }),
      signal: AbortSignal.timeout(10000),
      headersTimeout: 10000,
      bodyTimeout: 10000,
    });
    // A webhook acknowledgement is its HTTP status; response bodies are never read or saved.
    response.body.on('error', () => {}); // Discarding a body emits an expected abort event.
    response.body.destroy();
    return {
      statusCode: response.statusCode,
      error:
        response.statusCode >= 200 && response.statusCode < 300
          ? null
          : `Webhook returned HTTP ${response.statusCode}`,
    };
  } catch {
    return {
      statusCode: null,
      error: 'Webhook could not be delivered (timeout, connection, TLS, or network policy)',
    };
  } finally {
    await agent.destroy();
  }
}
