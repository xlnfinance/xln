import type { RuntimeInput } from '../types';
import { decodeRuntimeAdapterMessage, encodeRuntimeAdapterMessage } from './codec';
import type {
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterRequest,
  RuntimeAdapterResponse,
  RuntimeAdapterStatus,
  RuntimeAdapterPush,
} from './types';
import { RuntimeAdapterError } from './errors';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RuntimeAdapterRequestBody =
  | { op: 'auth'; key?: string }
  | { op: 'read'; path: string; query?: RuntimeAdapterReadQuery }
  | { op: 'send'; input: RuntimeInput };

const nextBackoff = (attempt: number, maxMs: number): number =>
  Math.min(maxMs, Math.max(1_000, 2 ** Math.min(attempt, 5) * 250));

const isTerminalAuthFailure = (error: unknown): boolean =>
  error instanceof RuntimeAdapterError && error.code === 'E_UNAUTHORIZED' && error.retryable !== true;

const toWebSocketBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

export class RemoteRuntimeAdapter implements RuntimeAdapter {
  readonly mode = 'remote' as const;

  private ws: WebSocket | null = null;
  private config: RuntimeAdapterConfig | null = null;
  private pending = new Map<string, PendingRequest>();
  private changeCbs = new Set<(height: number) => void>();
  private statusCbs = new Set<(status: RuntimeAdapterStatus) => void>();
  private requestId = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private terminalAuthFailure = false;
  private currentStatus: RuntimeAdapterStatus = 'disconnected';
  private height = 0;
  private level: RuntimeAdapterAuthLevel | null = null;

  get status(): RuntimeAdapterStatus {
    return this.currentStatus;
  }

  get currentHeight(): number {
    return this.height;
  }

  get authLevel(): RuntimeAdapterAuthLevel | null {
    return this.level;
  }

  async connect(config: RuntimeAdapterConfig): Promise<void> {
    if (config.mode !== 'remote') throw new RuntimeAdapterError('E_BAD_QUERY', 'RemoteRuntimeAdapter requires mode=remote');
    if (!config.wsUrl) throw new RuntimeAdapterError('E_BAD_QUERY', 'wsUrl is required');
    this.config = config;
    this.intentionalClose = false;
    this.terminalAuthFailure = false;
    try {
      await this.openSocket();
      await this.authenticateIfNeeded();
    } catch (error) {
      this.handleConnectionFailure(error);
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.terminalAuthFailure = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending(new RuntimeAdapterError('E_INTERNAL', 'adapter disconnected', true));
    this.ws?.close();
    this.ws = null;
    this.setStatus('disconnected');
  }

  read<T = unknown>(path: string, query?: RuntimeAdapterReadQuery): Promise<T> {
    return this.request<T>({ op: 'read', path, ...(query ? { query } : {}) });
  }

  send(input: RuntimeInput): Promise<{ height: number }> {
    return this.request<{ height: number }>({ op: 'send', input });
  }

  onChange(cb: (height: number) => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  onStatus(cb: (status: RuntimeAdapterStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  private setStatus(status: RuntimeAdapterStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const cb of this.statusCbs) cb(status);
  }

  private async openSocket(): Promise<void> {
    const wsUrl = this.config?.wsUrl;
    if (!wsUrl) throw new RuntimeAdapterError('E_BAD_QUERY', 'wsUrl is required');
    this.setStatus('connecting');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      let settled = false;
      ws.onopen = () => {
        settled = true;
        this.ws = ws;
        this.reconnectAttempt = 0;
        this.setStatus('connected');
        resolve();
      };
      ws.onerror = () => {
        if (!settled) reject(new RuntimeAdapterError('E_INTERNAL', `failed to connect ${wsUrl}`, true));
      };
      ws.onmessage = (event) => this.handleMessage(event.data);
      ws.onclose = () => this.handleClose();
    });
  }

  private handleClose(): void {
    this.ws = null;
    this.level = null;
    this.failPending(new RuntimeAdapterError('E_INTERNAL', 'runtime adapter socket closed', true));
    this.setStatus(this.terminalAuthFailure ? 'error' : this.intentionalClose ? 'disconnected' : 'error');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.terminalAuthFailure || !this.config || this.reconnectTimer) return;
    const maxMs = Math.max(1_000, Number(this.config.reconnectMaxMs ?? 30_000));
    const delay = nextBackoff(this.reconnectAttempt++, maxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket()
        .then(() => this.authenticateIfNeeded())
        .catch((error) => this.handleConnectionFailure(error));
    }, delay);
  }

  private handleConnectionFailure(error: unknown): void {
    if (isTerminalAuthFailure(error)) {
      this.terminalAuthFailure = true;
      this.intentionalClose = true;
      this.level = null;
      this.failPending(error);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const socket = this.ws;
      this.ws = null;
      socket?.close();
      this.setStatus('error');
      return;
    }
    this.setStatus('error');
    this.scheduleReconnect();
  }

  private async authenticateIfNeeded(): Promise<void> {
    if (!this.config?.authKey) return;
    const response = await this.request<{ authLevel: RuntimeAdapterAuthLevel; currentHeight?: number }>({ op: 'auth', key: this.config.authKey });
    this.level = response.authLevel;
    this.height = Math.max(this.height, Math.floor(Number(response.currentHeight || 0)));
    for (const cb of this.changeCbs) cb(this.height);
  }

  private handleMessage(raw: unknown): void {
    let message: RuntimeAdapterResponse | RuntimeAdapterPush;
    try {
      message = decodeRuntimeAdapterMessage<RuntimeAdapterResponse | RuntimeAdapterPush>(raw);
    } catch (error) {
      this.setStatus('error');
      this.failPending(error);
      this.ws?.close();
      return;
    }

    if ('op' in message && message.op === 'tick') {
      this.height = Math.max(this.height, Math.floor(Number(message.height || 0)));
      for (const cb of this.changeCbs) cb(this.height);
      return;
    }

    if (!('inReplyTo' in message)) return;
    const pending = this.pending.get(message.inReplyTo);
    if (!pending) return;
    this.pending.delete(message.inReplyTo);
    if (message.ok) {
      pending.resolve(message.payload);
    } else {
      pending.reject(new RuntimeAdapterError(message.error.code, message.error.message, message.error.retryable));
    }
  }

  private request<T>(body: RuntimeAdapterRequestBody): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'runtime adapter is not connected', true));
    }
    const id = `r-${++this.requestId}`;
    const payload = { v: 1 as const, id, ...body } as RuntimeAdapterRequest;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = Math.max(1_000, Number(this.config?.requestTimeoutMs ?? 15_000));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeAdapterError('E_INTERNAL', `runtime adapter request timed out: ${body.op}`, true));
      }, timeoutMs);
      const pending: PendingRequest = {
        timer,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.pending.set(id, pending);
      try {
        this.ws?.send(toWebSocketBuffer(encodeRuntimeAdapterMessage(payload)));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private failPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
