/**
 * Pluggable push notification transports.
 *
 * The watchtower process stays free of heavy provider SDKs. Two working
 * transports ship here:
 *   - ConsolePushSender: logs the wake (dev / smoke / no-op default).
 *   - WebhookPushSender: POSTs the notification JSON to an operator-configured
 *     endpoint that fans out to APNs / FCM. This keeps APNs/FCM credentials and
 *     native libraries out of the tower; the webhook is the integration seam.
 */

import type { PushNotificationV1, PushSendResult, PushSender } from './types';

export class ConsolePushSender implements PushSender {
  readonly kind = 'console';

  async send(notification: PushNotificationV1): Promise<PushSendResult> {
    console.log(
      `[PUSH] (console) platform=${notification.platform} collapse=${notification.collapseKey} ` +
        `title="${notification.title}" token=${notification.token.slice(0, 12)}…`,
    );
    return { ok: true };
  }
}

export class WebhookPushSender implements PushSender {
  readonly kind = 'webhook';

  constructor(
    private readonly endpoint: string,
    private readonly authToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!/^https?:\/\//i.test(endpoint)) throw new Error('PUSH_WEBHOOK_ENDPOINT_INVALID');
  }

  async send(notification: PushNotificationV1): Promise<PushSendResult> {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
        },
        body: JSON.stringify(notification),
      });
      if (!response.ok) return { ok: false, error: `PUSH_WEBHOOK_HTTP_${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
