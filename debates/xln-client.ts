import { createHmac, randomUUID } from 'node:crypto';

export type DaemonFrameLog = {
  id: number;
  timestamp: number;
  level: string;
  category: string;
  message: string;
  entityId?: string;
  data?: Record<string, unknown>;
};

export type DaemonFrameReceiptResponse = {
  fromHeight: number;
  toHeight: number;
  returned: number;
  receipts: Array<{ height: number; timestamp: number; logs: DaemonFrameLog[] }>;
};

export type DaemonRoute = {
  path: string[];
  hops: Array<{ from: string; to: string; fee: string; feePPM: number }>;
  totalFee: string;
  senderAmount: string;
  recipientAmount: string;
  probability: number;
};

export type DaemonQueuePaymentResult = {
  sourceEntityId: string;
  signerId: string;
  targetEntityId: string;
  tokenId: number;
  amount: string;
  route: string[];
  mode: 'direct' | 'htlc';
  description?: string;
  startedAtMs?: number;
  secret?: string;
  hashlock?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export const deriveDebatesCapabilityToken = (
  seed: string,
  role: 'read' | 'full',
  expiresAtMs: number,
  options: { audience: string; keyId?: string; tokenId?: string },
): string => {
  const level = role === 'read' ? 'inspect' : 'admin';
  const audience = options.audience.trim().toLowerCase();
  const keyId = options.keyId || 'debates';
  const tokenId = options.tokenId || randomUUID();
  const payload = `xln-radapter-v1:cap:${level}:${Math.floor(expiresAtMs)}:${audience}:${keyId}:${tokenId}`;
  const signature = createHmac('sha256', seed.trim()).update(payload).digest('hex');
  return [
    'xlnra1',
    role,
    String(Math.floor(expiresAtMs)),
    Buffer.from(audience, 'utf8').toString('base64url'),
    Buffer.from(keyId, 'utf8').toString('base64url'),
    Buffer.from(tokenId, 'utf8').toString('base64url'),
    signature,
  ].join('.');
};

export class DaemonRpcClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private connected = false;

  constructor(private readonly url: string, private readonly authKey: string | (() => string) = '') {}

  isConnected(): boolean {
    return this.connected && this.socket?.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
    this.connected = false;
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      socket.onopen = () => {
        socket.onmessage = event => {
          try {
            const message = JSON.parse(String(event.data)) as { inReplyTo?: string; data?: unknown; error?: string };
            if (!message.inReplyTo) return;
            const pending = this.pending.get(message.inReplyTo);
            if (!pending) return;
            clearTimeout(pending.timeout);
            this.pending.delete(message.inReplyTo);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.data);
          } catch (error) {
            this.rejectAll(error instanceof Error ? error : new Error(String(error)));
          }
        };
        socket.onclose = () => {
          this.connected = false;
          this.socket = null;
          this.connectPromise = null;
          this.rejectAll(new Error('Daemon websocket closed'));
        };
        socket.onerror = event => {
          if (!settled) fail(new Error(`Daemon websocket error: ${String(event.type || 'unknown')}`));
          else this.rejectAll(new Error('Daemon websocket error'));
        };
        this.socket = socket;
        this.connected = true;
        settled = true;
        resolve();
      };
      socket.onerror = event => fail(new Error(`Daemon websocket error: ${String(event.type || 'unknown')}`));
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    await this.ensureConnected();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Daemon websocket is not open');
    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Daemon RPC timed out for ${type}`));
      }, 12_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timeout });
      const key = typeof this.authKey === 'function' ? this.authKey() : this.authKey;
      this.socket!.send(JSON.stringify({ id, type, ...(key ? { key } : {}), ...payload }));
    });
  }

  async getFrameReceipts(params: {
    fromHeight: number;
    toHeight?: number;
    limit?: number;
    entityId?: string;
    eventNames?: string[];
  }): Promise<DaemonFrameReceiptResponse> {
    return await this.request<DaemonFrameReceiptResponse>('get_frame_receipts', params);
  }

  async findRoutes(params: {
    sourceEntityId: string;
    targetEntityId: string;
    tokenId: number;
    amount: string;
  }): Promise<{ routes: DaemonRoute[] }> {
    return await this.request<{ routes: DaemonRoute[] }>('find_routes', params);
  }

  async queuePayment(params: {
    sourceEntityId: string;
    signerId?: string;
    targetEntityId: string;
    tokenId: number;
    amount: string;
    description?: string;
    startedAtMs?: number;
    route?: string[];
    mode?: 'direct' | 'htlc';
  }): Promise<DaemonQueuePaymentResult> {
    return await this.request<DaemonQueuePaymentResult>('queue_payment', params);
  }
}
