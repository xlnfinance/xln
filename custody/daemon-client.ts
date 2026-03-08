export type DaemonFrameLog = {
  id: number;
  timestamp: number;
  level: string;
  category: string;
  message: string;
  entityId?: string;
  data?: Record<string, unknown>;
};

export type DaemonFrameReceipt = {
  height: number;
  timestamp: number;
  logs: DaemonFrameLog[];
};

export type DaemonFrameReceiptResponse = {
  fromHeight: number;
  toHeight: number;
  returned: number;
  receipts: DaemonFrameReceipt[];
};

export type DaemonRoute = {
  path: string[];
  hops: Array<{
    from: string;
    to: string;
    fee: string;
    feePPM: number;
  }>;
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
  secret?: string;
  hashlock?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 12_000;

export class DaemonRpcClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private connected = false;

  constructor(private readonly url: string) {}

  isConnected(): boolean {
    return this.connected && this.socket?.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
    this.connected = false;
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        // ignore
      }
      this.connectPromise = null;
    }
  }

  private rejectAllPending(error: Error): void {
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

      const finishResolve = () => {
        if (settled) return;
        settled = true;
        this.socket = socket;
        this.connected = true;
        resolve();
      };

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        this.socket = null;
        this.connected = false;
        reject(error);
      };

      socket.onopen = () => {
        socket.onmessage = event => {
          try {
            const message = JSON.parse(String(event.data)) as {
              type?: string;
              inReplyTo?: string;
              data?: unknown;
              error?: string;
            };
            if (typeof message.inReplyTo !== 'string') {
              return;
            }
            const pending = this.pending.get(message.inReplyTo);
            if (!pending) return;
            clearTimeout(pending.timeout);
            this.pending.delete(message.inReplyTo);
            if (typeof message.error === 'string' && message.error.length > 0) {
              pending.reject(new Error(message.error));
              return;
            }
            pending.resolve(message.data);
          } catch (error) {
            this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
          }
        };

        socket.onclose = () => {
          this.connected = false;
          this.socket = null;
          this.connectPromise = null;
          this.rejectAllPending(new Error('Daemon websocket closed'));
        };

        socket.onerror = event => {
          if (!settled) {
            finishReject(new Error(`Daemon websocket error: ${String(event.type || 'unknown')}`));
            return;
          }
          this.connected = false;
          this.socket = null;
          this.connectPromise = null;
          this.rejectAllPending(new Error('Daemon websocket error'));
        };

        finishResolve();
      };

      socket.onerror = event => {
        finishReject(new Error(`Daemon websocket error: ${String(event.type || 'unknown')}`));
      };
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private async request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    await this.ensureConnected();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Daemon websocket is not open');
    }

    const id = crypto.randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Daemon RPC timed out for ${type}`));
      }, DEFAULT_TIMEOUT_MS);

      this.pending.set(id, { resolve: value => resolve(value as T), reject, timeout });

      try {
        this.socket!.send(JSON.stringify({ id, type, ...payload }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
    route?: string[];
    mode?: 'direct' | 'htlc';
  }): Promise<DaemonQueuePaymentResult> {
    return await this.request<DaemonQueuePaymentResult>('queue_payment', params);
  }
}
