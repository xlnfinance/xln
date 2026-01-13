import type { RuntimeInput, EntityInput } from './types';
import { deserializeWsMessage, makeHelloNonce, hashHelloMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';
import { signDigest } from './account-crypto';

type WebSocketLike = WebSocket & { on: (event: string, cb: (...args: any[]) => void) => void };

export type RuntimeWsClientOptions = {
  url: string;
  runtimeId: string;
  signerId?: string;
  onRuntimeInput?: (from: string, input: RuntimeInput) => Promise<void> | void;
  onEntityInput?: (from: string, input: EntityInput) => Promise<void> | void;
  onError?: (error: Error) => void;
  reconnectMs?: number;
};

const isBrowser = typeof window !== 'undefined' && typeof WebSocket !== 'undefined';

const createWs = async (url: string): Promise<WebSocketLike> => {
  if (isBrowser) {
    const ws = new WebSocket(url) as WebSocketLike;
    ws.binaryType = 'arraybuffer';
    return ws;
  }
  const { WebSocket: NodeWebSocket } = await import('ws');
  return new NodeWebSocket(url) as WebSocketLike;
};

export class RuntimeWsClient {
  private ws: WebSocketLike | null = null;
  private closed = false;
  private reconnectMs: number;
  private options: RuntimeWsClientOptions;

  constructor(options: RuntimeWsClientOptions) {
    this.options = options;
    this.reconnectMs = options.reconnectMs ?? 2000;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.ws = await createWs(this.options.url);

    if ('on' in this.ws) {
      this.ws.on('open', () => this.sendHello());
      this.ws.on('message', (data: Buffer) => this.handleMessage(data));
      this.ws.on('close', () => this.scheduleReconnect());
      this.ws.on('error', (err: Error) => {
        this.options.onError?.(err);
        this.scheduleReconnect();
      });
    } else {
      this.ws.onopen = () => this.sendHello();
      this.ws.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
      this.ws.onclose = () => this.scheduleReconnect();
      this.ws.onerror = (event: Event) => {
        this.options.onError?.(new Error(`WebSocket error: ${event.type}`));
        this.scheduleReconnect();
      };
    }
  }

  private sendHello() {
    if (this.options.signerId) {
      try {
        const timestamp = Date.now();
        const nonce = makeHelloNonce();
        const digest = hashHelloMessage(this.options.runtimeId, timestamp, nonce);
        const signature = signDigest(this.options.signerId, digest);
        this.sendRaw({
          type: 'hello',
          from: this.options.runtimeId,
          timestamp,
          auth: { nonce, signature, timestamp },
        });
        return;
      } catch (error) {
        this.options.onError?.(error as Error);
      }
    }
    this.sendRaw({ type: 'hello', from: this.options.runtimeId, timestamp: Date.now() });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    setTimeout(() => {
      if (!this.closed) {
        this.connect().catch(err => this.options.onError?.(err));
      }
    }, this.reconnectMs);
  }

  private async handleMessage(raw: string | Buffer | ArrayBuffer) {
    let msg: RuntimeWsMessage;
    try {
      msg = deserializeWsMessage(raw);
    } catch (error) {
      this.options.onError?.(error as Error);
      return;
    }

    if (msg.type === 'runtime_input' && msg.payload && msg.from) {
      await this.options.onRuntimeInput?.(msg.from, msg.payload as RuntimeInput);
      return;
    }
    if (msg.type === 'entity_input' && msg.payload && msg.from) {
      await this.options.onEntityInput?.(msg.from, msg.payload as EntityInput);
      return;
    }
  }

  sendRuntimeInput(to: string, input: RuntimeInput) {
    this.sendRaw({
      type: 'runtime_input',
      id: makeMessageId(),
      from: this.options.runtimeId,
      to,
      timestamp: Date.now(),
      payload: input,
    });
  }

  sendEntityInput(to: string, input: EntityInput) {
    this.sendRaw({
      type: 'entity_input',
      id: makeMessageId(),
      from: this.options.runtimeId,
      to,
      timestamp: Date.now(),
      payload: input,
    });
  }

  private sendRaw(msg: RuntimeWsMessage) {
    if (!this.ws) return;
    if ('readyState' in this.ws && this.ws.readyState !== 1) return;
    const payload = serializeWsMessage(msg);
    this.ws.send(payload);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
