/**
 * Pluggable push notification transports.
 *
 * The watchtower process stays free of heavy provider SDKs. Two working
 * transports ship here:
 *   - ConsolePushSender: logs an explicitly undelivered wake for dev/smoke.
 *   - WebhookPushSender: POSTs the notification JSON to an operator-configured
 *     endpoint that fans out to APNs / FCM. This keeps APNs/FCM credentials and
 *     native libraries out of the tower; the webhook is the integration seam.
 */

import type { PushNotificationV1, PushSendResult, PushSender } from './types';

const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

export class ConsolePushSender implements PushSender {
  readonly kind = 'console';

  async send(notification: PushNotificationV1): Promise<PushSendResult> {
    console.log(
      `[PUSH] (console) platform=${notification.platform} collapse=${notification.collapseKey} ` +
        `title="${notification.title}" token=${notification.token.slice(0, 12)}…`,
    );
    return { ok: false, error: 'PUSH_DELIVERY_NOT_CONFIGURED' };
  }
}

export class WebhookPushSender implements PushSender {
  readonly kind = 'webhook';

  constructor(
    endpoint: string,
    private readonly authToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_WEBHOOK_TIMEOUT_MS,
  ) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error('PUSH_WEBHOOK_ENDPOINT_INVALID');
    }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
    if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) {
      throw new Error('PUSH_WEBHOOK_ENDPOINT_INVALID');
    }
    if (authToken && parsed.protocol !== 'https:') throw new Error('PUSH_WEBHOOK_AUTH_REQUIRES_HTTPS');
    this.endpoint = parsed.toString();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('PUSH_WEBHOOK_TIMEOUT_INVALID');
  }

  private readonly endpoint: string;

  async send(notification: PushNotificationV1): Promise<PushSendResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const response = await Promise.race([
        this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
          },
          body: JSON.stringify(notification),
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`PUSH_WEBHOOK_TIMEOUT:${this.timeoutMs}`));
          }, this.timeoutMs);
        }),
      ]);
      if (!response.ok) return { ok: false, error: `PUSH_WEBHOOK_HTTP_${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export type PushSenderConfig = {
  kind?: 'console' | 'webhook';
  webhookEndpoint?: string;
  webhookAuthToken?: string;
};

export const createPushSender = (config?: PushSenderConfig): PushSender => {
  const kind = config?.kind || (config?.webhookEndpoint ? 'webhook' : 'console');
  if (kind === 'webhook') {
    if (!config?.webhookEndpoint) throw new Error('PUSH_WEBHOOK_ENDPOINT_REQUIRED');
    return new WebhookPushSender(config.webhookEndpoint, config.webhookAuthToken);
  }
  return new ConsolePushSender();
};
