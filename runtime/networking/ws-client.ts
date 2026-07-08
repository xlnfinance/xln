import type { RoutedEntityInput } from '../types';
import { deserializeWsMessage, makeHelloNonce, hashHelloMessage, makeMessageId, serializeWsMessage, type RuntimeWsMessage } from './ws-protocol';
import { signDigest } from '../account-crypto';
import { encryptJSON, decryptJSON, pubKeyToHex } from './p2p-crypto';
import { asFailFastPayload, failfastAssert } from './failfast';
import { isRuntimeId, normalizeRuntimeId } from './runtime-id';

const NORMAL_CLOSE_CODES = new Set([1000, 1001]);

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
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

type WebSocketLike = BrowserWebSocket | NodeWebSocket;

function isNodeWebSocket(ws: WebSocketLike): ws is NodeWebSocket {
  return 'on' in ws && typeof (ws as NodeWebSocket).on === 'function';
}

const waitForSocketClose = async (ws: WebSocketLike | null, timeoutMs = 1_000): Promise<void> => {
  if (!ws) return;
  const readyState = 'readyState' in ws && typeof ws.readyState === 'number' ? ws.readyState : undefined;
  if (readyState === undefined || readyState >= 2) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);

    if (isNodeWebSocket(ws)) {
      ws.on('close', () => {
        clearTimeout(timer);
        finish();
      });
      try {
        ws.close();
      } catch {
        clearTimeout(timer);
        finish();
      }
      return;
    }

    const browserWs = ws as BrowserWebSocket;
    const prevOnClose = browserWs.onclose;
    browserWs.onclose = (event) => {
      clearTimeout(timer);
      try {
        prevOnClose?.call(browserWs as unknown as WebSocket, event);
      } finally {
        finish();
      }
    };
    try {
      browserWs.close();
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
};

export type RuntimeWsClientOptions = {
  url: string;
  runtimeId: string;
  signerId?: string;
  seed?: Uint8Array | string;
  useHelloAuth?: boolean;
  encryptionKeyPair?: { publicKey: Uint8Array; privateKey: Uint8Array }; // For E2E encryption
  getTargetEncryptionKey?: (runtimeId: string) => Uint8Array | null; // Lookup target's pubkey
  onPeerEncryptionKey?: (runtimeId: string, pubKeyHex: string) => void;
  onEntityInput?: (from: string, input: RoutedEntityInput, timestamp?: number) => Promise<void> | void;
  onGossipRequest?: (from: string, payload: unknown) => Promise<void> | void;
  onGossipResponse?: (from: string, payload: unknown) => Promise<void> | void;
  onGossipAnnounce?: (from: string, payload: unknown) => Promise<void> | void;
  onRecoveryBundleRequest?: (from: string, lookupKey: string) => Promise<unknown> | unknown;
  onRecoveryBundleResponse?: (from: string, payload: unknown, message: RuntimeWsMessage) => Promise<void> | void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  // <= 0 means unlimited reconnect attempts
  maxReconnectAttempts?: number;
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

const readRecoveryLookupKey = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return '';
  return String((payload as { lookupKey?: unknown }).lookupKey || '').trim();
};

const DEFAULT_RECOVERY_BUNDLE_REQUEST_TIMEOUT_MS = 5_000;

type PendingRecoveryBundleRequest = {
  timer: ReturnType<typeof setTimeout>;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
};

export class RuntimeWsClient {
  private static readonly BACKOFF_BASE_MS = 1000;
  private static readonly BACKOFF_MAX_MS = 30000;
  private static readonly BACKOFF_MIN_MS = 250;
  private static readonly DEFAULT_MAX_RECONNECT_ATTEMPTS = 0;
  private ws: WebSocketLike | null = null;
  private closed = false;
  private connecting = false;
  private options: RuntimeWsClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private nextReconnectAt: number = 0;
  private suppressNextClose = false;
  private readonly maxReconnectAttempts: number;
  private readonly pendingRecoveryBundleRequests = new Map<string, PendingRecoveryBundleRequest>();

  constructor(options: RuntimeWsClientOptions) {
    failfastAssert(!!options.url, 'WS_INIT_URL_MISSING', 'RuntimeWsClient url is required');
    failfastAssert(!!options.runtimeId, 'WS_INIT_RUNTIME_MISSING', 'RuntimeWsClient runtimeId is required');
    failfastAssert(
      isRuntimeId(options.runtimeId),
      'WS_INIT_RUNTIME_INVALID',
      'RuntimeWsClient runtimeId must be canonical 0x-prefixed 20-byte address',
      { runtimeId: options.runtimeId },
    );
    this.options = { ...options, runtimeId: normalizeRuntimeId(options.runtimeId) };
    this.maxReconnectAttempts = Number.isFinite(options.maxReconnectAttempts as number)
      ? Number(options.maxReconnectAttempts)
      : RuntimeWsClient.DEFAULT_MAX_RECONNECT_ATTEMPTS;
  }

  getUrl(): string {
    return this.options.url;
  }

  async connect(): Promise<void> {
    // Guard: no concurrent connections
    if (this.connecting) {
      return;
    }
    if (this.isOpen()) {
      return;
    }

    this.closed = false;
    this.connecting = true;

    // Close any stale WS before creating new one
    if (this.ws) {
      const staleWs = this.ws;
      this.suppressNextClose = true;
      this.ws = null;
      await waitForSocketClose(staleWs);
    }

    this.ws = await createWs(this.options.url);

    if ('on' in this.ws) {
      this.ws.on('open', () => {
        this.connecting = false;
        this.reconnectAttempts = 0;
        console.log(`[WS] Connected to ${this.options.url}`);
        if (!this.sendHello()) return;
        this.options.onOpen?.();
      });
      this.ws.on('message', (data: Buffer) => this.handleMessage(data));
      this.ws.on('close', (code: number, reasonBuf: Buffer) => {
        this.connecting = false;
        this.rejectPendingRecoveryBundleRequests(new Error('RECOVERY_REQUEST_SOCKET_CLOSED'));
        if (this.suppressNextClose) {
          this.suppressNextClose = false;
          return;
        }
        if (this.closed) return;
        const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf || '');
        const summary =
          `WS_CLOSE runtime=${this.options.runtimeId.slice(0, 10)} relay=${this.options.url} ` +
          `code=${Number(code || 0)} reason="${reason || 'n/a'}"`;
        const shouldReconnect = this.shouldReconnectAfterClose(Number(code || 0), reason);
        if (shouldReconnect) {
          const normalClose = NORMAL_CLOSE_CODES.has(Number(code || 0));
          (normalClose ? console.warn : console.error)(`[WS] ${summary} — scheduling reconnect`);
          if (!normalClose) this.options.onError?.(new Error(`WS_DISCONNECTED: ${summary}`));
          this.scheduleReconnect();
        } else if (!this.isDuplicateRuntimeClose(Number(code || 0), reason)) {
          console.warn(`[WS] ${summary} — reconnect disabled`);
        }
      });
      this.ws.on('error', (err: Error) => {
        this.connecting = false;
        this.options.onError?.(err);
        // Some WS handshake failures emit only "error" without a "close" callback.
        // Keep reconnect ownership idempotent via scheduleReconnect() guards.
        if (!this.closed && !this.isOpen()) {
          console.error(`[WS] Error on ${this.options.url} — scheduling reconnect`);
          this.scheduleReconnect();
        }
      });
    } else {
      this.ws.onopen = () => {
        this.connecting = false;
        this.reconnectAttempts = 0;
        console.log(`[WS] Connected to ${this.options.url}`);
        if (!this.sendHello()) return;
        this.options.onOpen?.();
      };
      this.ws.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
      this.ws.onclose = (event: CloseEvent) => {
        this.connecting = false;
        this.rejectPendingRecoveryBundleRequests(new Error('RECOVERY_REQUEST_SOCKET_CLOSED'));
        if (this.suppressNextClose) {
          this.suppressNextClose = false;
          return;
        }
        if (this.closed) return;
        const code = Number(event.code || 0);
        const reason = String(event.reason || '');
        const summary =
          `WS_CLOSE runtime=${this.options.runtimeId.slice(0, 10)} relay=${this.options.url} ` +
          `code=${code} reason="${reason || 'n/a'}" clean=${event.wasClean ? 1 : 0}`;
        const shouldReconnect = this.shouldReconnectAfterClose(code, reason);
        if (shouldReconnect) {
          const normalClose = event.wasClean || NORMAL_CLOSE_CODES.has(code);
          (normalClose ? console.warn : console.error)(`[WS] ${summary} — scheduling reconnect`);
          if (!normalClose) this.options.onError?.(new Error(`WS_DISCONNECTED: ${summary}`));
          this.scheduleReconnect();
        } else if (!this.isDuplicateRuntimeClose(code, reason)) {
          console.warn(`[WS] ${summary} — reconnect disabled`);
        }
      };
      this.ws.onerror = (event: Event) => {
        this.connecting = false;
        this.options.onError?.(new Error(`WebSocket error: ${event.type}`));
        // Browser can also surface error before close in transient network failures.
        if (!this.closed && !this.isOpen()) {
          console.error(`[WS] Error on ${this.options.url} — scheduling reconnect`);
          this.scheduleReconnect();
        }
      };
    }
  }

  private computeBackoffMs(): number {
    const base = RuntimeWsClient.BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1);
    const clamped = Math.min(base, RuntimeWsClient.BACKOFF_MAX_MS);
    const jitter = 0.7 + Math.random() * 0.6; // 0.7..1.3
    return Math.max(RuntimeWsClient.BACKOFF_MIN_MS, Math.round(clamped * jitter));
  }

  private scheduleReconnect() {
    if (this.closed || this.connecting || this.isOpen()) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const capped = this.maxReconnectAttempts > 0;
    if (capped && this.reconnectAttempts > this.maxReconnectAttempts) {
      const err = new Error(
        `WS_RECONNECT_EXHAUSTED: ${this.options.url} failed after ${this.maxReconnectAttempts} attempts`
      );
      console.error(`[WS] Reconnect exhausted for ${this.options.url}`);
      this.options.onError?.(err);
      return;
    }
    const delayMs = this.computeBackoffMs();
    this.nextReconnectAt = Date.now() + delayMs;
    console.log(`[WS] Reconnecting to ${this.options.url} in ${delayMs}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextReconnectAt = 0;
      if (this.closed) return;
      this.connect().catch(error => this.options.onError?.(error as Error));
    }, delayMs);
  }

  private shouldReconnectAfterClose(code: number, reason: string): boolean {
    if (this.closed) return false;
    if (this.isDuplicateRuntimeClose(code, reason)) {
      const browserStandby = typeof document !== 'undefined';
      if (!browserStandby) {
        this.closed = true;
      }
      console.info(
        `[WS] Duplicate runtime session for ${this.options.runtimeId} on ${this.options.url}; ` +
        (browserStandby
          ? 'entering standby until this tab is visible again'
          : 'stopping auto-reconnect for this client'),
      );
      return false;
    }
    return true;
  }

  private isDuplicateRuntimeClose(code: number, reason: string): boolean {
    const normalizedReason = String(reason || '').toLowerCase();
    return code === 4009 || normalizedReason.includes('duplicate-runtime');
  }

  getReconnectState(): { attempt: number; nextAt: number } | null {
    if (this.reconnectTimer && this.nextReconnectAt > 0) {
      return { attempt: this.reconnectAttempts, nextAt: this.nextReconnectAt };
    }
    return null;
  }

  private rejectPendingRecoveryBundleRequests(error: Error): void {
    if (this.pendingRecoveryBundleRequests.size === 0) return;
    const pending = Array.from(this.pendingRecoveryBundleRequests.values());
    this.pendingRecoveryBundleRequests.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private settlePendingRecoveryBundleRequest(
    id: string | undefined,
    payload: unknown,
    error?: string,
  ): boolean {
    if (!id) return false;
    const pending = this.pendingRecoveryBundleRequests.get(id);
    if (!pending) return false;
    this.pendingRecoveryBundleRequests.delete(id);
    clearTimeout(pending.timer);
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(payload);
    }
    return true;
  }

  private sendHello(): boolean {
    const encryptionKeyPair = this.options.encryptionKeyPair;
    if (!encryptionKeyPair) {
      throw new Error(`WS_HELLO_ENCRYPTION_KEY_MISSING: runtimeId=${this.options.runtimeId}`);
    }
    if (this.options.useHelloAuth) {
      if (!this.options.signerId || !this.options.seed) {
        const error = new Error(`WS_HELLO_AUTH_KEY_MISSING: runtimeId=${this.options.runtimeId}`);
        this.options.onError?.(error);
        this.ws?.close();
        return false;
      }
      // Relay routers require signed hello; direct test servers can still opt out.
      try {
        const timestamp = nextTimestamp();
        const nonce = makeHelloNonce();
        const digest = hashHelloMessage(this.options.runtimeId, timestamp, nonce);
        const signature = signDigest(this.options.seed, this.options.signerId, digest);
        this.sendRaw({
          type: 'hello',
          from: this.options.runtimeId,
          fromEncryptionPubKey: pubKeyToHex(encryptionKeyPair.publicKey),
          timestamp,
          auth: { nonce, signature, timestamp },
        });
        return true;
      } catch (error) {
        this.options.onError?.(error as Error);
        this.ws?.close();
        return false;
      }
    }
    this.sendRaw({
      type: 'hello',
      from: this.options.runtimeId,
      fromEncryptionPubKey: pubKeyToHex(encryptionKeyPair.publicKey),
      timestamp: nextTimestamp(),
    });
    return true;
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
      if (this.settlePendingRecoveryBundleRequest(msg.inReplyTo, undefined, msg.error || 'Unknown error')) {
        return;
      }
      this.options.onError?.(new Error(msg.error || 'Unknown error'));
      return;
    }

    if (typeof msg.from === 'string' && typeof msg.fromEncryptionPubKey === 'string') {
      this.options.onPeerEncryptionKey?.(msg.from, msg.fromEncryptionPubKey);
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

      await this.options.onEntityInput?.(msg.from, entityInput, typeof msg.timestamp === 'number' ? msg.timestamp : undefined);
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
    if (msg.type === 'recovery_bundle_request' && msg.from) {
      const lookupKey = readRecoveryLookupKey(msg.payload);
      if (!lookupKey) {
        this.sendRecoveryBundleResponse(msg.from, msg.id, undefined, 'Recovery lookupKey is required');
        return;
      }
      if (!this.options.onRecoveryBundleRequest) {
        this.sendRecoveryBundleResponse(msg.from, msg.id, undefined, 'Recovery bundle reads unavailable');
        return;
      }
      try {
        const payload = await this.options.onRecoveryBundleRequest(msg.from, lookupKey);
        this.sendRecoveryBundleResponse(msg.from, msg.id, payload);
      } catch (error) {
        this.sendRecoveryBundleResponse(
          msg.from,
          msg.id,
          undefined,
          `Recovery bundle request failed: ${(error as Error).message}`,
        );
      }
      return;
    }
    if (msg.type === 'recovery_bundle_response' && msg.from) {
      if (this.settlePendingRecoveryBundleRequest(msg.inReplyTo, msg.payload, msg.error)) {
        return;
      }
      if (msg.error) {
        this.options.onError?.(new Error(msg.error));
        return;
      }
      await this.options.onRecoveryBundleResponse?.(msg.from, msg.payload, msg);
      return;
    }
  }

  sendEntityInput(to: string, input: RoutedEntityInput, ingressTimestamp?: number): boolean {
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
      fromEncryptionPubKey: pubKeyToHex(this.options.encryptionKeyPair.publicKey),
      to,
      timestamp:
        typeof ingressTimestamp === 'number' && Number.isFinite(ingressTimestamp)
          ? ingressTimestamp
          : nextTimestamp(),
      payload,
      encrypted: true,
      entityId: input.entityId,
      txs: input.entityTxs?.length ?? 0,
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

  sendRecoveryBundleRequest(to: string, lookupKey: string): boolean {
    return this.sendRecoveryBundleRequestWithId(to, lookupKey, makeMessageId());
  }

  private sendRecoveryBundleRequestWithId(to: string, lookupKey: string, id: string): boolean {
    const key = String(lookupKey || '').trim();
    if (!key) {
      this.options.onError?.(new Error('RECOVERY_LOOKUP_KEY_MISSING'));
      return false;
    }
    return this.sendRaw({
      type: 'recovery_bundle_request',
      id,
      from: this.options.runtimeId,
      to,
      timestamp: nextTimestamp(),
      payload: { lookupKey: key },
    });
  }

  requestRecoveryBundles<T = unknown>(
    to: string,
    lookupKey: string,
    timeoutMs = DEFAULT_RECOVERY_BUNDLE_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const key = String(lookupKey || '').trim();
    if (!key) return Promise.reject(new Error('RECOVERY_LOOKUP_KEY_MISSING'));
    const targetRuntimeId = normalizeRuntimeId(to);
    if (!targetRuntimeId) return Promise.reject(new Error('RECOVERY_TARGET_RUNTIME_INVALID'));
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : DEFAULT_RECOVERY_BUNDLE_REQUEST_TIMEOUT_MS;
    const id = makeMessageId();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRecoveryBundleRequests.delete(id);
        reject(new Error(`RECOVERY_REQUEST_TIMEOUT: target=${targetRuntimeId} lookupKey=${key.slice(0, 12)}`));
      }, waitMs);
      this.pendingRecoveryBundleRequests.set(id, {
        timer,
        resolve: (payload: unknown) => resolve(payload as T),
        reject,
      });
      const sent = this.sendRecoveryBundleRequestWithId(targetRuntimeId, key, id);
      if (!sent) {
        this.pendingRecoveryBundleRequests.delete(id);
        clearTimeout(timer);
        reject(new Error(`RECOVERY_REQUEST_SEND_FAILED: target=${targetRuntimeId}`));
      }
    });
  }

  private sendRecoveryBundleResponse(
    to: string,
    inReplyTo: string | undefined,
    payload?: unknown,
    error?: string,
  ): boolean {
    return this.sendRaw({
      type: 'recovery_bundle_response',
      id: makeMessageId(),
      from: this.options.runtimeId,
      to,
      timestamp: nextTimestamp(),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(error ? { error } : { payload }),
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
    const outboundMsg =
      this.options.encryptionKeyPair && msg.from && !msg.fromEncryptionPubKey
        ? {
            ...msg,
            fromEncryptionPubKey: pubKeyToHex(this.options.encryptionKeyPair.publicKey),
          }
        : msg;
    try {
      failfastAssert(typeof outboundMsg.type === 'string', 'WS_SEND_TYPE_INVALID', 'Outgoing WS message type must be string', { msg: outboundMsg });
      failfastAssert(
        typeof outboundMsg.from === 'string' && outboundMsg.from.length > 0,
        'WS_SEND_FROM_INVALID',
        'Outgoing WS message missing from',
        { msgType: outboundMsg.type },
      );
      failfastAssert(
        typeof outboundMsg.fromEncryptionPubKey === 'string' && outboundMsg.fromEncryptionPubKey.length > 0,
        'WS_SEND_ENCRYPTION_PUBKEY_MISSING',
        'Outgoing WS message missing fromEncryptionPubKey',
        { msgType: outboundMsg.type },
      );
      if (outboundMsg.type !== 'hello') {
        failfastAssert(
          typeof outboundMsg.id === 'string' && outboundMsg.id.length > 0,
          'WS_SEND_ID_INVALID',
          'Outgoing WS message missing id',
          { msgType: outboundMsg.type },
        );
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
    const payload = serializeWsMessage(outboundMsg);
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

  isConnecting(): boolean {
    return this.connecting;
  }

  pause() {
    this.connecting = false;
    this.rejectPendingRecoveryBundleRequests(new Error('RECOVERY_REQUEST_SOCKET_PAUSED'));
    this.suppressNextClose = true;
    this.reconnectAttempts = 0;
    this.nextReconnectAt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  close() {
    this.closed = true;
    this.connecting = false;
    this.rejectPendingRecoveryBundleRequests(new Error('RECOVERY_REQUEST_SOCKET_CLOSED'));
    this.suppressNextClose = true;
    this.reconnectAttempts = 0;
    this.nextReconnectAt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
