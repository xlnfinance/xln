import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { RuntimeInput } from '../../runtime/types';
import {
  decodeRuntimeAdapterBrowserMessage,
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
} from './codec';
import type {
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterBrainVaultInput,
  RuntimeAdapterBrainVaultOptions,
  RuntimeAdapterBrainVaultProgress,
  RuntimeAdapterBrainVaultRecovery,
  RuntimeAdapterBrainVaultResult,
  RuntimeAdapterCommandLaneKind,
  RuntimeAdapterConfig,
  RuntimeAdapterControlAction,
  RuntimeAdapterReadQuery,
  RuntimeAdapterRequest,
  RuntimeAdapterResponse,
  RuntimeAdapterCrossJurisdictionIntentResult,
  RuntimeAdapterSendResult,
  RuntimeAdapterSendOptions,
  RuntimeAdapterStatus,
  RuntimeAdapterPush,
} from './types';
import { RuntimeAdapterError } from './errors';
import {
  createRuntimeAdapterIdentityChallenge,
  verifyRuntimeAdapterServerIdentity,
  type RuntimeAdapterServerIdentityProof,
} from './server-identity';
import { XLN_PROTOCOL_VERSION } from '../../protocol/version';

type PendingRequest = {
  op: RuntimeAdapterRequestBody['op'];
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SocketContext = Readonly<{
  ws: WebSocket;
  generation: number;
}>;

type RuntimeAdapterRequestBody =
  | { op: 'auth'; key?: string; challenge: string; ownerSignature?: string }
  | { op: 'read'; path: string; query?: RuntimeAdapterReadQuery }
  | { op: 'send'; commandId: string; commandSequence: number; input: RuntimeInput }
  | { op: 'control'; action: RuntimeAdapterControlAction }
  | { op: 'brainvault-derive'; jobId: string; input: RuntimeAdapterBrainVaultInput }
  | { op: 'brainvault-cancel'; jobId: string }
  | { op: 'brainvault-reveal' }
  | { op: 'cross-j-intent'; route: CrossJurisdictionSwapRoute };

const BRAINVAULT_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

const nextBackoff = (attempt: number, maxMs: number): number =>
  Math.min(maxMs, Math.max(1_000, 2 ** Math.min(attempt, 5) * 250));

const isTerminalAuthFailure = (error: unknown): boolean =>
  error instanceof RuntimeAdapterError && error.code === 'E_UNAUTHORIZED' && error.retryable !== true;

const toWebSocketBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const recordOrNull = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const assertBrainVaultTransportIsConfidential = (wsUrl: string | undefined): void => {
  const url = new URL(String(wsUrl || ''));
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new RuntimeAdapterError(
      'E_UNAUTHORIZED',
      'BrainVault secrets require wss:// or a localhost ws:// node',
    );
  }
};

const parseBrainVaultResult = (value: unknown): RuntimeAdapterBrainVaultResult => {
  const result = recordOrNull(value);
  if (!result) throw new RuntimeAdapterError('E_INTERNAL', 'BrainVault node returned an invalid result');
  for (const key of ['specId', 'ethereumAddress', 'entityId'] as const) {
    if (typeof result[key] !== 'string' || !result[key]) {
      throw new RuntimeAdapterError('E_INTERNAL', `BrainVault node omitted ${key}`);
    }
  }
  if (result['backend'] !== 'native-node') {
    throw new RuntimeAdapterError('E_INTERNAL', 'BrainVault node returned the wrong backend');
  }
  for (const key of ['shardCount', 'factor', 'workers', 'derivationTimeMs', 'height'] as const) {
    if (!Number.isSafeInteger(result[key]) || Number(result[key]) < 0) {
      throw new RuntimeAdapterError('E_INTERNAL', `BrainVault node returned invalid ${key}`);
    }
  }
  if (typeof result['created'] !== 'boolean') {
    throw new RuntimeAdapterError('E_INTERNAL', 'BrainVault node returned invalid owner state');
  }
  return result as RuntimeAdapterBrainVaultResult;
};

const parseBrainVaultRecovery = (value: unknown): RuntimeAdapterBrainVaultRecovery => {
  const result = recordOrNull(value);
  if (!result || typeof result['mnemonic24'] !== 'string' || !result['mnemonic24'].trim()) {
    throw new RuntimeAdapterError('E_INTERNAL', 'BrainVault node returned an invalid mnemonic');
  }
  return { mnemonic24: result['mnemonic24'] };
};

const heightFromPayload = (payload: unknown): number => {
  const record = recordOrNull(payload);
  if (!record) return 0;
  const direct = Math.max(0, Math.floor(Number(record['latestHeight'] ?? record['height'] ?? 0)));
  const head = recordOrNull(record['head']);
  const headHeight = Math.max(0, Math.floor(Number(head?.['latestHeight'] ?? 0)));
  return Math.max(direct, headHeight);
};

const parseCommandReadiness = (
  value: Record<string, unknown>,
): { ready: boolean; reason: string | null } => {
  const ready = value['commandReady'];
  const reason = value['commandReadyReason'];
  if (typeof ready !== 'boolean') {
    throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter server omitted canonical command readiness');
  }
  if (ready) {
    if (reason !== null) {
      throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter server returned contradictory command readiness');
    }
    return { ready: true, reason: null };
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter server omitted command readiness reason');
  }
  return { ready: false, reason: reason.trim() };
};

export class RemoteRuntimeAdapter implements RuntimeAdapter {
  readonly mode = 'remote' as const;

  private ws: WebSocket | null = null;
  private socketGeneration = 0;
  private authenticatedGeneration: number | null = null;
  private connectionAttempt = 0;
  private config: RuntimeAdapterConfig | null = null;
  private pending = new Map<string, PendingRequest>();
  private changeCbs = new Set<(height: number) => void>();
  private statusCbs = new Set<(status: RuntimeAdapterStatus) => void>();
  private brainVaultProgressCbs = new Map<string, (progress: RuntimeAdapterBrainVaultProgress) => void>();
  private requestId = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private terminalAuthFailure = false;
  private currentStatus: RuntimeAdapterStatus = 'disconnected';
  private height = 0;
  private level: RuntimeAdapterAuthLevel | null = null;
  private id = '';
  private fingerprint: string | null = null;
  private nextSequence: number | null = null;
  private laneKind: RuntimeAdapterCommandLaneKind | null = null;
  private serverCommandReady = false;
  private serverCommandReadyReason: string | null = 'adapter-disconnected';

  get status(): RuntimeAdapterStatus {
    return this.currentStatus;
  }

  get runtimeId(): string {
    return this.id || String(this.config?.runtimeId || '').trim().toLowerCase();
  }

  get serverFingerprint(): string | null {
    return this.fingerprint;
  }

  get currentHeight(): number {
    return this.height;
  }

  get nextCommandSequence(): number | null {
    return this.nextSequence;
  }

  get commandLaneKind(): RuntimeAdapterCommandLaneKind | null {
    return this.laneKind;
  }

  get authLevel(): RuntimeAdapterAuthLevel | null {
    return this.level;
  }

  get commandReady(): boolean {
    return this.currentStatus === 'connected' && this.serverCommandReady;
  }

  get commandReadyReason(): string | null {
    if (this.currentStatus !== 'connected') return `adapter-${this.currentStatus}`;
    return this.serverCommandReady ? null : this.serverCommandReadyReason;
  }

  async connect(config: RuntimeAdapterConfig): Promise<void> {
    if (config.mode !== 'remote') throw new RuntimeAdapterError('E_BAD_QUERY', 'RemoteRuntimeAdapter requires mode=remote');
    if (!config.wsUrl) throw new RuntimeAdapterError('E_BAD_QUERY', 'wsUrl is required');
    this.config = config;
    const attempt = ++this.connectionAttempt;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.id = String(config.runtimeId || '').trim().toLowerCase();
    this.clearAuthenticatedSession('adapter-connecting');
    this.intentionalClose = false;
    this.terminalAuthFailure = false;
    try {
      await this.openSocket();
      if (attempt !== this.connectionAttempt) {
        throw new RuntimeAdapterError('E_INTERNAL', 'runtime adapter connection attempt was superseded', true);
      }
      await this.authenticateIfNeeded();
      if (attempt !== this.connectionAttempt) {
        throw new RuntimeAdapterError('E_INTERNAL', 'runtime adapter authentication attempt was superseded', true);
      }
      this.setStatus('connected');
    } catch (error) {
      this.handleConnectionFailure(error, attempt);
      throw error;
    }
  }

  disconnect(): void {
    this.connectionAttempt += 1;
    this.intentionalClose = true;
    this.terminalAuthFailure = false;
    this.clearAuthenticatedSession('adapter-disconnected');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending(new RuntimeAdapterError('E_INTERNAL', 'adapter disconnected', true));
    const socket = this.ws;
    this.ws = null;
    this.socketGeneration += 1;
    socket?.close();
    this.setStatus('disconnected');
  }

  read<T = unknown>(path: string, query?: RuntimeAdapterReadQuery): Promise<T> {
    return this.request<T>({ op: 'read', path, ...(query ? { query } : {}) });
  }

  async ensureOwnerCommandLane(): Promise<void> {
    if (this.laneKind === 'owner' && this.authenticatedGeneration === this.socketGeneration) return;
    await this.authenticateIfNeeded(true);
  }

  send(input: RuntimeInput, options: RuntimeAdapterSendOptions = {}): Promise<RuntimeAdapterSendResult> {
    const commandId = String(options.commandId || '').trim();
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(commandId)) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'remote runtime send requires a caller-owned commandId');
    }
    const commandSequence = Number(options.commandSequence);
    if (!Number.isSafeInteger(commandSequence) || commandSequence <= 0) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'remote runtime send requires a positive commandSequence');
    }
    this.requireCommandReady();
    return this.request<RuntimeAdapterSendResult>({ op: 'send', commandId, commandSequence, input })
      .then((result) => {
        this.nextSequence = Math.max(this.nextSequence ?? 1, commandSequence + 1);
        return result;
      });
  }

  submitCrossJurisdictionIntent(
    route: CrossJurisdictionSwapRoute,
  ): Promise<RuntimeAdapterCrossJurisdictionIntentResult> {
    // M1 deliberately bypasses the durable RuntimeInput command lane. An
    // offline Hub is not a financial failure: the user may manually resubmit
    // the same canonical orderId after reconnecting.
    this.requireCommandReady();
    return this.request<RuntimeAdapterCrossJurisdictionIntentResult>({
      op: 'cross-j-intent',
      route,
    });
  }

  async deriveBrainVault(
    input: RuntimeAdapterBrainVaultInput,
    options: RuntimeAdapterBrainVaultOptions = {},
  ): Promise<RuntimeAdapterBrainVaultResult> {
    this.requireFreshAdmin('BrainVault requires fresh admin auth');
    assertBrainVaultTransportIsConfidential(this.config?.wsUrl);
    if (options.signal?.aborted) throw new Error('BRAINVAULT_DERIVATION_ABORTED');
    const jobId = `brainvault-${++this.requestId}`;
    if (options.onProgress) this.brainVaultProgressCbs.set(jobId, options.onProgress);
    const cancel = (): void => {
      void this.request({ op: 'brainvault-cancel', jobId }).catch(() => undefined);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await this.request<unknown>(
        { op: 'brainvault-derive', jobId, input },
        BRAINVAULT_REQUEST_TIMEOUT_MS,
      );
      if (options.signal?.aborted) throw new Error('BRAINVAULT_DERIVATION_ABORTED');
      return parseBrainVaultResult(result);
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      this.brainVaultProgressCbs.delete(jobId);
    }
  }

  async revealBrainVaultMnemonic(): Promise<RuntimeAdapterBrainVaultRecovery> {
    this.requireFreshAdmin('BrainVault export requires fresh admin auth');
    assertBrainVaultTransportIsConfidential(this.config?.wsUrl);
    return parseBrainVaultRecovery(await this.request<unknown>({ op: 'brainvault-reveal' }));
  }

  control<T = unknown>(action: RuntimeAdapterControlAction): Promise<T> {
    return this.request<T>({ op: 'control', action });
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

  private noteHeight(height: unknown, options: { allowDecrease?: boolean } = {}): void {
    const next = Math.max(0, Math.floor(Number(height || 0)));
    if (options.allowDecrease === true ? next === this.height : next <= this.height) return;
    this.height = next;
    for (const cb of this.changeCbs) cb(this.height);
  }

  private clearAuthenticatedSession(reason: string): void {
    this.level = null;
    this.fingerprint = null;
    this.nextSequence = null;
    this.laneKind = null;
    this.authenticatedGeneration = null;
    this.setServerCommandReadiness(false, reason);
  }

  private isCurrentSocket({ ws, generation }: SocketContext): boolean {
    return this.ws === ws && this.socketGeneration === generation;
  }

  private requireFreshAdmin(message: string): void {
    const socket = this.ws;
    if (
      this.level !== 'admin'
      || this.authenticatedGeneration !== this.socketGeneration
      || !socket
      || socket.readyState !== WebSocket.OPEN
    ) {
      throw new RuntimeAdapterError('E_UNAUTHORIZED', message);
    }
  }

  private async openSocket(): Promise<void> {
    const wsUrl = this.config?.wsUrl;
    if (!wsUrl) throw new RuntimeAdapterError('E_BAD_QUERY', 'wsUrl is required');
    const previousSocket = this.ws;
    this.ws = null;
    previousSocket?.close();
    this.failPending(new RuntimeAdapterError('E_INTERNAL', 'runtime adapter socket replaced', true));
    const generation = ++this.socketGeneration;
    this.clearAuthenticatedSession('adapter-connecting');
    this.setStatus('connecting');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const context: SocketContext = { ws, generation };
      ws.binaryType = 'arraybuffer';
      let settled = false;
      ws.onopen = () => {
        if (generation !== this.socketGeneration) {
          if (!settled) {
            settled = true;
            reject(new RuntimeAdapterError('E_INTERNAL', 'stale runtime adapter socket opened', true));
          }
          ws.close();
          return;
        }
        settled = true;
        this.ws = ws;
        this.reconnectAttempt = 0;
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new RuntimeAdapterError('E_INTERNAL', `failed to connect ${wsUrl}`, true));
        }
      };
      ws.onmessage = (event) => this.handleMessage(event.data, context);
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new RuntimeAdapterError('E_INTERNAL', `runtime adapter socket closed before open: ${wsUrl}`, true));
        }
        this.handleClose(context);
      };
    });
  }

  private handleClose(context: SocketContext): void {
    if (!this.isCurrentSocket(context)) return;
    this.ws = null;
    this.clearAuthenticatedSession('adapter-disconnected');
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
      const attempt = ++this.connectionAttempt;
      this.openSocket()
        .then(() => {
          if (attempt !== this.connectionAttempt) {
            throw new RuntimeAdapterError('E_INTERNAL', 'runtime adapter reconnect was superseded', true);
          }
          return this.authenticateIfNeeded();
        })
        .then(() => {
          if (attempt === this.connectionAttempt && !this.intentionalClose) this.setStatus('connected');
        })
        .catch((error) => this.handleConnectionFailure(error, attempt));
    }, delay);
  }

  private handleConnectionFailure(error: unknown, attempt: number): void {
    if (attempt !== this.connectionAttempt || this.intentionalClose) return;
    if (isTerminalAuthFailure(error)) {
      this.terminalAuthFailure = true;
      this.intentionalClose = true;
      this.clearAuthenticatedSession('adapter-auth-failed');
      this.failPending(error);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const socket = this.ws;
      this.ws = null;
      this.socketGeneration += 1;
      socket?.close();
      this.setStatus('error');
      return;
    }
    this.clearAuthenticatedSession('adapter-connection-failed');
    this.failPending(error);
    const socket = this.ws;
    this.ws = null;
    this.socketGeneration += 1;
    socket?.close();
    this.setStatus('error');
    this.scheduleReconnect();
  }

  private async authenticateIfNeeded(requireOwner = false): Promise<void> {
    if (!this.config?.authKey) {
      if (requireOwner) {
        throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime owner binding requires an admin capability');
      }
      return;
    }
    const ws = this.ws;
    const generation = this.socketGeneration;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new RuntimeAdapterError('E_INTERNAL', 'runtime adapter is not connected', true);
    }
    const context: SocketContext = { ws, generation };
    const challenge = createRuntimeAdapterIdentityChallenge();
    const expectedRuntimeId = this.id || String(this.config.runtimeId || '').trim().toLowerCase();
    const ownerSignature = this.config.ownerBindingSigner
      ? await this.config.ownerBindingSigner({
          runtimeId: expectedRuntimeId,
          challenge,
          capability: this.config.authKey,
        })
      : null;
    if (requireOwner && !ownerSignature) {
      throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime owner binding requires an unlocked matching vault');
    }
    const response = await this.request<RuntimeAdapterServerIdentityProof & {
      authLevel: RuntimeAdapterAuthLevel;
      commandLaneKind: RuntimeAdapterCommandLaneKind;
      currentHeight?: number;
      nextCommandSequence?: number;
      commandReady: boolean;
      commandReadyReason: string | null;
    }>({
      op: 'auth',
      key: this.config.authKey,
      challenge,
      ...(ownerSignature ? { ownerSignature } : {}),
    }, undefined, context);
    if (!this.isCurrentSocket(context)) {
      throw new RuntimeAdapterError('E_INTERNAL', 'runtime adapter auth completed on a stale socket', true);
    }
    let verified: RuntimeAdapterServerIdentityProof;
    try {
      verified = verifyRuntimeAdapterServerIdentity(
        response,
        challenge,
        this.id || this.config.runtimeId,
      );
    } catch (error) {
      throw new RuntimeAdapterError(
        'E_UNAUTHORIZED',
        `runtime adapter server identity verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.commandLaneKind !== 'owner' && response.commandLaneKind !== 'capability') {
      throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter server returned an invalid command lane kind');
    }
    if (requireOwner && response.commandLaneKind !== 'owner') {
      throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter server did not bind the vault-owner lane');
    }
    const nextCommandSequence = Number(response.nextCommandSequence);
    if (!Number.isSafeInteger(nextCommandSequence) || nextCommandSequence <= 0) {
      throw new RuntimeAdapterError('E_UNAUTHORIZED', 'runtime adapter server returned an invalid command frontier');
    }
    const readiness = parseCommandReadiness(response);
    if (!this.isCurrentSocket(context)) {
      throw new RuntimeAdapterError('E_INTERNAL', 'runtime adapter auth became stale before commit', true);
    }
    this.level = response.authLevel;
    this.id = verified.runtimeId;
    this.fingerprint = verified.identityFingerprint;
    this.laneKind = response.commandLaneKind;
    this.nextSequence = nextCommandSequence;
    this.authenticatedGeneration = generation;
    this.setServerCommandReadiness(readiness.ready, readiness.reason);
    this.noteHeight(response.currentHeight, { allowDecrease: true });
  }

  private handleMessage(raw: unknown, context: SocketContext): void {
    if (!this.isCurrentSocket(context)) return;
    let message: RuntimeAdapterResponse | RuntimeAdapterPush;
    try {
      const decoded = typeof raw === 'string'
        ? decodeRuntimeAdapterBrowserMessage(raw)
        : decodeRuntimeAdapterMessage(raw);
      if ('id' in decoded) throw new Error('RADAPTER_SERVER_MESSAGE_REQUEST_FORBIDDEN');
      message = decoded;
    } catch (error) {
      this.clearAuthenticatedSession('adapter-protocol-error');
      this.setStatus('error');
      this.failPending(error);
      context.ws.close();
      return;
    }

    if ('op' in message) {
      if (message.op === 'tick') {
        this.setServerCommandReadiness(message.commandReady, message.commandReadyReason);
        this.noteHeight(message.height, { allowDecrease: true });
        return;
      }
      if (message.op === 'brainvault-progress') {
        this.brainVaultProgressCbs.get(message.jobId)?.(message.progress);
        return;
      }
    }

    if (!('inReplyTo' in message)) return;
    const pending = this.pending.get(message.inReplyTo);
    if (!pending) return;
    this.pending.delete(message.inReplyTo);
    if (message.ok) {
      // Auth establishes a fresh connection frontier. Reads can lag behind a
      // newer tick while persistence catches up, so they must stay monotonic.
      this.noteHeight(heightFromPayload(message.payload), { allowDecrease: pending.op === 'auth' });
      pending.resolve(message.payload);
    } else {
      pending.reject(new RuntimeAdapterError(message.error.code, message.error.message, message.error.retryable));
    }
  }

  private request<T>(
    body: RuntimeAdapterRequestBody,
    timeoutOverrideMs?: number,
    expectedContext?: SocketContext,
  ): Promise<T> {
    const context = expectedContext ?? (
      this.ws ? { ws: this.ws, generation: this.socketGeneration } : null
    );
    if (!context || !this.isCurrentSocket(context) || context.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'runtime adapter is not connected', true));
    }
    const id = `r-${++this.requestId}`;
    const payload = { v: XLN_PROTOCOL_VERSION, id, ...body } as RuntimeAdapterRequest;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = Math.max(1_000, Number(timeoutOverrideMs ?? this.config?.requestTimeoutMs ?? 15_000));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const requestLabel = body.op === 'read' ? `${body.op}:${body.path}` : body.op;
        reject(new RuntimeAdapterError(
          'E_INTERNAL',
          `runtime adapter request timed out: ${requestLabel} after ${timeoutMs}ms (pending=${this.pending.size})`,
          true,
        ));
      }, timeoutMs);
      const pending: PendingRequest = {
        op: body.op,
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
        if (!this.isCurrentSocket(context)) {
          throw new RuntimeAdapterError('E_INTERNAL', 'runtime adapter socket changed before send', true);
        }
        context.ws.send(toWebSocketBuffer(encodeRuntimeAdapterMessage(payload)));
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

  private setServerCommandReadiness(ready: boolean, reason: string | null): void {
    const changed = this.serverCommandReady !== ready || this.serverCommandReadyReason !== reason;
    this.serverCommandReady = ready;
    this.serverCommandReadyReason = reason;
    if (changed) {
      for (const cb of this.changeCbs) cb(this.height);
    }
  }

  private requireCommandReady(): void {
    if (this.commandReady) return;
    throw new RuntimeAdapterError(
      'E_COMMAND_PENDING',
      `RUNTIME_COMMAND_NOT_READY:${this.commandReadyReason || 'unknown'}`,
      true,
      250,
    );
  }
}
