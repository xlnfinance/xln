import type { RuntimeInput, RoutedEntityInput } from '../types';
import { deserializeWsMessage, makeHelloNonce, hashHelloMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';
import { signDigest } from '../account-crypto';
import { encryptJSON, decryptJSON } from './p2p-crypto';
import { asFailFastPayload, failfastAssert } from './failfast';

// Separate interfaces for browser and Node.js WebSocket implementations
interface BrowserWebSocket {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer | Blob): void;
  close(): void;
  onopen: ((this: WebSocket, ev: Event) => any) | null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null;
  onclose: ((this: WebSocket, ev: CloseEvent) => any) | null;
  onerror: ((this: WebSocket, ev: Event) => any) | null;
}

interface NodeWebSocket {
  binaryType?: string;
  readyState?: number;
  send(data: string | Buffer): void;
  close(): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

type WebSocketLike = BrowserWebSocket | NodeWebSocket;

function isNodeWebSocket(ws: WebSocketLike): ws is NodeWebSocket {
  return 'on' in ws && typeof (ws as NodeWebSocket).on === 'function';
}

export type RuntimeWsClientOptions = {
  url: string;
  runtimeId: string;
  signerId?: string;
  seed?: Uint8Array | string;  // Required if signerId is provided for hello auth
  encryptionKeyPair?: { publicKey: Uint8Array; privateKey: Uint8Array }; // For E2E encryption
  getTargetEncryptionKey?: (runtimeId: string) => Uint8Array | null; // Lookup target's pubkey
  onRuntimeInput?: (from: string, input: RuntimeInput) => Promise<void> | void;
  onEntityInput?: (from: string, input: RoutedEntityInput) => Promise<void> | void;
  onGossipRequest?: (from: string, payload: unknown) => Promise<void> | void;
  onGossipResponse?: (from: string, payload: unknown) => Promise<void> | void;
  onGossipAnnounce?: (from: string, payload: unknown) => Promise<void> | void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
};

const isBrowser = typeof window !== 'undefined' && typeof WebSocket !== 'undefined';
let wsTimestampCounter = 0;

const nextTimestamp = () => {
  const now = Date.now();
  if (now <= wsTimestampCounter) {
    wsTimestampCounter += 1;
    return wsTimestampCounter;
  }
  wsTimestampCounter = now;
  return wsTimestampCounter;
};

const createWs = async (url: string): Promise<WebSocketLike> => {
  if (isBrowser) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    return ws as BrowserWebSocket;
  }
  const ws = await import('ws');
  const instance = new ws.default(url);
  return instance as NodeWebSocket;
};

export class RuntimeWsClient {
  private static readonly RECONNECT_DELAY_MS = 5000;
  private ws: WebSocketLike | null = null;
  private closed = false;
  private connecting = false;
  private options: RuntimeWsClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private suppressNextClose = false;

  constructor(options: RuntimeWsClientOptions) {
    failfastAssert(!!options.url, 'WS_INIT_URL_MISSING', 'RuntimeWsClient url is required');
    failfastAssert(!!options.runtimeId, 'WS_INIT_RUNTIME_MISSING', 'RuntimeWsClient runtimeId is required');
    this.options = options;
  }

  getUrl(): string {
    return this.options.url;
  }

  async connect(): Promise<void> {
    // Guard: no concurrent connections
    if (this.connecting) {
      console.warn(`[WS] Already connecting to ${this.options.url} — skipping`);
      return;
    }
    if (this.isOpen()) {
      console.warn(`[WS] Already connected to ${this.options.url} — skipping`);
      return;
    }

    this.closed = false;
    this.connecting = true;

    // Close any stale WS before creating new one
    if (this.ws) {
      this.suppressNextClose = true;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    this.ws = await createWs(this.options.url);

    if ('on' in this.ws) {
      this.ws.on('open', () => {
        this.connecting = false;
        this.reconnectAttempts = 0;
        console.log(`[WS] Connected to ${this.options.url}`);
        this.sendHello();
        this.options.onOpen?.();
      });
      this.ws.on('message', (data: Buffer) => this.handleMessage(data));
      this.ws.on('close', () => {
        this.connecting = false;
        if (this.suppressNextClose) {
          this.suppressNextClose = false;
          return;
        }
        if (!this.closed) {
          console.error(`[WS] Connection lost to ${this.options.url} — reconnect in ${RuntimeWsClient.RECONNECT_DELAY_MS}ms`);
          this.options.onError?.(new Error(`WS_DISCONNECTED: Connection lost to ${this.options.url}`));
          this.scheduleReconnect();
        }
      });
      this.ws.on('error', (err: Error) => {
        this.connecting = false;
        // Let "close" own reconnect scheduling; prevents double-scheduling loops.
        this.options.onError?.(err);
      });
    } else {
      this.ws.onopen = () => {
        this.connecting = false;
        this.reconnectAttempts = 0;
        console.log(`[WS] Connected to ${this.options.url}`);
        this.sendHello();
        this.options.onOpen?.();
      };
      this.ws.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
      this.ws.onclose = () => {
        this.connecting = false;
        if (this.suppressNextClose) {
          this.suppressNextClose = false;
          return;
        }
        if (!this.closed) {
          console.error(`[WS] Connection lost to ${this.options.url} — reconnect in ${RuntimeWsClient.RECONNECT_DELAY_MS}ms`);
          this.options.onError?.(new Error(`WS_DISCONNECTED: Connection lost to ${this.options.url}`));
          this.scheduleReconnect();
        }
      };
      this.ws.onerror = (event: Event) => {
        this.connecting = false;
        // Let "close" own reconnect scheduling; prevents double-scheduling loops.
        this.options.onError?.(new Error(`WebSocket error: ${event.type}`));
      };
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.connecting || this.isOpen()) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.connect().catch(error => this.options.onError?.(error as Error));
    }, RuntimeWsClient.RECONNECT_DELAY_MS);
  }

  private sendHello() {
    if (this.options.signerId && this.options.seed) {
      try {
        const timestamp = nextTimestamp();
        const nonce = makeHelloNonce();
        const digest = hashHelloMessage(this.options.runtimeId, timestamp, nonce);
        const signature = signDigest(this.options.seed, this.options.signerId, digest);
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
    this.sendRaw({ type: 'hello', from: this.options.runtimeId, timestamp: nextTimestamp() });
  }

  private async handleMessage(raw: string | Buffer | ArrayBuffer) {
    let msg: RuntimeWsMessage;
    try {
      msg = deserializeWsMessage(raw);
      failfastAssert(!!msg && typeof msg === 'object', 'WS_MSG_NOT_OBJECT', 'WS message must be an object');
      failfastAssert(typeof msg.type === 'string', 'WS_MSG_TYPE_INVALID', 'WS message type must be a string', { msg });
    } catch (error) {
      this.sendDebugEvent({
        level: 'error',
        code: 'WS_MSG_DECODE_FAILFAST',
        failfast: asFailFastPayload(error),
      });
      this.options.onError?.(error as Error);
      return;
    }
    if (msg.type === 'error') {
      this.options.onError?.(new Error(msg.error || 'Unknown error'));
      return;
    }

    if (msg.type === 'runtime_input' && msg.payload && msg.from) {
      await this.options.onRuntimeInput?.(msg.from, msg.payload as RuntimeInput);
      return;
    }
    if (msg.type === 'entity_input' && msg.payload && msg.from) {
      // entity_input received - decrypt below

      // Reject unencrypted entity_input messages
      if (!msg.encrypted) {
        console.error(`❌ WS-CLIENT: Rejected unencrypted entity_input from ${msg.from}`);
        this.sendDebugEvent({
          level: 'error',
          code: 'P2P_UNENCRYPTED',
          message: 'Rejected unencrypted entity_input',
          from: msg.from,
        });
        this.options.onError?.(new Error(`P2P_UNENCRYPTED: Received unencrypted entity_input from ${msg.from}`));
        return;
      }

      if (!this.options.encryptionKeyPair) {
        console.error(`❌ WS-CLIENT: No encryption keypair for decryption`);
        this.sendDebugEvent({
          level: 'error',
          code: 'P2P_NO_DECRYPTION',
          message: 'Missing encryption keypair for decrypt',
          from: msg.from,
        });
        this.options.onError?.(new Error('P2P_NO_DECRYPTION: Cannot decrypt without keypair'));
        return;
      }

      // Decrypt - throws on error (fail-fast)
      let entityInput: RoutedEntityInput;
      try {
        entityInput = decryptJSON<RoutedEntityInput>(msg.payload as string, this.options.encryptionKeyPair.privateKey);
        // Decrypted successfully
      } catch (decryptError) {
        console.error(`❌ WS-CLIENT-DECRYPT-FAILED:`, decryptError);
        this.sendDebugEvent({
          level: 'error',
          code: 'DECRYPT_FAIL',
          message: (decryptError as Error).message,
          from: msg.from,
        });
        this.options.onError?.(decryptError as Error);
        return;
      }

      await this.options.onEntityInput?.(msg.from, entityInput);
      return;
    }
    if (msg.type === 'gossip_request' && msg.payload && msg.from) {
      await this.options.onGossipRequest?.(msg.from, msg.payload);
      return;
    }
    if ((msg.type === 'gossip_response' || msg.type === 'gossip_subscribed') && msg.payload && msg.from) {
      await this.options.onGossipResponse?.(msg.from, msg.payload);
      return;
    }
    if ((msg.type === 'gossip_announce' || msg.type === 'gossip_update') && msg.payload && msg.from) {
      await this.options.onGossipAnnounce?.(msg.from, msg.payload);
      return;
    }
  }

  sendRuntimeInput(to: string, input: RuntimeInput): boolean {
    return this.sendRaw({
      type: 'runtime_input',
      id: makeMessageId(),
      from: this.options.runtimeId,
      to,
      timestamp: nextTimestamp(),
      payload: input,
    });
  }

  sendEntityInput(to: string, input: RoutedEntityInput): boolean {
    // Encryption is MANDATORY for entity_input messages
    if (!this.options.getTargetEncryptionKey || !this.options.encryptionKeyPair) {
      throw new Error('P2P_NO_ENCRYPTION: Encryption not configured');
    }

    const targetPubKey = this.options.getTargetEncryptionKey(to);
    if (!targetPubKey) {
      throw new Error(`P2P_NO_PUBKEY: No encryption key for ${to}`);
    }

    // Encrypt - throws on error (fail-fast, never send plaintext)
    const payload = encryptJSON(input, targetPubKey);

    return this.sendRaw({
      type: 'entity_input',
      id: makeMessageId(),
      from: this.options.runtimeId,
      to,
      timestamp: nextTimestamp(),
      payload,
      encrypted: true,
    });
  }

  sendGossipRequest(to: string, payload: unknown): boolean {
    return this.sendRaw({
      type: 'gossip_request',
      id: makeMessageId(),
      from: this.options.runtimeId,
      to,
      timestamp: nextTimestamp(),
      payload,
    });
  }

  sendGossipResponse(to: string, payload: unknown): boolean {
    return this.sendRaw({
      type: 'gossip_response',
      id: makeMessageId(),
      from: this.options.runtimeId,
      to,
      timestamp: nextTimestamp(),
      payload,
    });
  }

  sendGossipAnnounce(to: string, payload: unknown): boolean {
    return this.sendRaw({
      type: 'gossip_announce',
      id: makeMessageId(),
      from: this.options.runtimeId,
      to,
      timestamp: nextTimestamp(),
      payload,
    });
  }

  sendGossipSubscribe(payload: { scope?: 'all'; entityIds?: string[] }): boolean {
    return this.sendRaw({
      type: 'gossip_subscribe',
      id: makeMessageId(),
      from: this.options.runtimeId,
      to: this.options.runtimeId, // To relay (self)
      timestamp: nextTimestamp(),
      payload,
    });
  }

  sendDebugEvent(payload: unknown): boolean {
    return this.sendRaw({
      type: 'debug_event',
      id: makeMessageId(),
      from: this.options.runtimeId,
      timestamp: nextTimestamp(),
      payload,
    });
  }

  private sendRaw(msg: RuntimeWsMessage): boolean {
    if (!this.ws) return false;
    if ('readyState' in this.ws && this.ws.readyState !== 1) return false;
    try {
      failfastAssert(typeof msg.type === 'string', 'WS_SEND_TYPE_INVALID', 'Outgoing WS message type must be string', { msg });
      failfastAssert(typeof msg.from === 'string' && msg.from.length > 0, 'WS_SEND_FROM_INVALID', 'Outgoing WS message missing from', { msgType: msg.type });
      if (msg.type !== 'hello') {
        failfastAssert(typeof msg.id === 'string' && msg.id.length > 0, 'WS_SEND_ID_INVALID', 'Outgoing WS message missing id', { msgType: msg.type });
      }
    } catch (error) {
      this.options.onError?.(error as Error);
      this.sendDebugEvent({
        level: 'error',
        code: 'WS_SEND_FAILFAST',
        failfast: asFailFastPayload(error),
      });
      return false;
    }
    const payload = serializeWsMessage(msg);
    try {
      this.ws.send(payload);
      return true;
    } catch (error) {
      this.options.onError?.(error as Error);
      return false;
    }
  }

  isOpen(): boolean {
    return !!this.ws && 'readyState' in this.ws && this.ws.readyState === 1;
  }

  close() {
    this.closed = true;
    this.connecting = false;
    this.suppressNextClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
