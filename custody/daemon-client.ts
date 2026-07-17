import { SigningKey, hexlify } from 'ethers';
import { deriveSignerAddressSync, deriveSignerKeySync } from '../runtime/account/crypto';
import { createStructuredLogger } from '../runtime/infra/logger';
import { RuntimeAdapterError } from '../runtime/radapter/errors';
import { buildRuntimeAdapterOwnerBindingDigest } from '../runtime/radapter/owner-binding';
import { RemoteRuntimeAdapter } from '../runtime/radapter/remote';
import type {
  RuntimeAdapterFrameLog,
  RuntimeAdapterFrameReceiptResponse,
  RuntimeAdapterPaymentRoute,
  RuntimeAdapterPaymentRoutesResponse,
  RuntimeAdapterSendResult,
} from '../runtime/radapter/types';
import type { EntityTx, RuntimeInput } from '../runtime/types';

export type DaemonAuthKeyProvider = string | (() => string);
export type DaemonFrameLog = RuntimeAdapterFrameLog;
export type DaemonFrameReceipt = RuntimeAdapterFrameReceiptResponse['receipts'][number];
export type DaemonFrameReceiptResponse = RuntimeAdapterFrameReceiptResponse;
export type DaemonRoute = RuntimeAdapterPaymentRoute;

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
  hashlock?: string;
  commandId: string;
  commandSequence: number;
};

export type DaemonQueuePaymentParams = {
  sourceEntityId: string;
  signerId: string;
  targetEntityId: string;
  tokenId: number;
  amount: string;
  description?: string;
  route?: string[];
  mode?: 'direct' | 'htlc';
  commandId: string;
  commandSequence?: number;
  onCommandPrepared?: (commandSequence: number) => void | Promise<void>;
};

const daemonLog = createStructuredLogger('custody.daemon');
const COMMIT_WAIT_MS = 45_000;
const COMMIT_POLL_MS = 150;
const ENTITY_ID_PATTERN = /^0x[0-9a-f]{64}$/;
const SIGNER_ID_PATTERN = /^0x[0-9a-f]{40}$/;
const HASHLOCK_PATTERN = /^0x[0-9a-f]{64}$/;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const normalizeEntityId = (value: unknown, code: string): string => {
  const entityId = String(value || '').trim().toLowerCase();
  if (!ENTITY_ID_PATTERN.test(entityId)) throw new RuntimeAdapterError('E_BAD_QUERY', code);
  return entityId;
};

const normalizePositiveInteger = (value: unknown, code: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RuntimeAdapterError('E_BAD_QUERY', code);
  return parsed;
};

const normalizeSignerId = (value: unknown): string => {
  const signerId = String(value || '').trim().toLowerCase();
  if (!SIGNER_ID_PATTERN.test(signerId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'custody payment signer must be an EOA address');
  }
  return signerId;
};

const normalizePositiveAmount = (value: unknown): string => {
  const amount = String(value || '').trim();
  try {
    if (BigInt(amount) <= 0n) throw new Error('non-positive');
  } catch {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'custody payment amount must be a positive integer string');
  }
  return amount;
};

const normalizeRoute = (route: string[] | undefined, source: string, target: string): string[] => {
  if (!Array.isArray(route) || route.length < 2) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'custody payment route must contain source and target');
  }
  const normalized = route.map((entry, index) => normalizeEntityId(entry, `custody payment route[${index}] is invalid`));
  if (normalized[0] !== source || normalized.at(-1) !== target) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'custody payment route endpoints do not match the request');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'custody payment route contains a cycle');
  }
  return normalized;
};

const normalizeDescription = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  const description = String(value);
  if (!description.trim()) throw new RuntimeAdapterError('E_BAD_QUERY', 'custody payment description cannot be empty');
  return description;
};

const eventData = (log: DaemonFrameLog): Record<string, unknown> =>
  log.data && typeof log.data === 'object' && !Array.isArray(log.data) ? log.data : {};

/**
 * Canonical custody transport. Reads may use a bearer capability, but durable
 * payment retries require the stable vault-owner lane. A renewed capability
 * deliberately cannot reset that lane's command frontier after response loss.
 */
export class DaemonRpcClient {
  private adapter: RemoteRuntimeAdapter | null = null;
  private connectPromise: Promise<RemoteRuntimeAdapter> | null = null;
  private readonly ownerRuntimeId: string | null;
  private readonly ownerSigningKey: SigningKey | null;

  constructor(
    private readonly url: string,
    private readonly authKey: DaemonAuthKeyProvider = '',
    ownerRuntimeSeed = '',
  ) {
    const seed = String(ownerRuntimeSeed || '').trim();
    this.ownerRuntimeId = seed ? deriveSignerAddressSync(seed, '1').toLowerCase() : null;
    this.ownerSigningKey = seed ? new SigningKey(hexlify(deriveSignerKeySync(seed, '1'))) : null;
  }

  isConnected(): boolean {
    return this.adapter?.status === 'connected';
  }

  async close(): Promise<void> {
    this.adapter?.disconnect();
    this.adapter = null;
    this.connectPromise = null;
  }

  private currentAuthKey(): string {
    const key = typeof this.authKey === 'function' ? this.authKey() : this.authKey;
    const normalized = String(key || '').trim();
    if (!normalized) throw new RuntimeAdapterError('E_UNAUTHORIZED', 'custody daemon auth key is required');
    return normalized;
  }

  private resetAdapter(): void {
    this.adapter?.disconnect();
    this.adapter = null;
    this.connectPromise = null;
  }

  private async connect(requireOwner: boolean): Promise<RemoteRuntimeAdapter> {
    if (this.adapter?.status === 'connected') {
      if (!requireOwner || this.adapter.commandLaneKind === 'owner') return this.adapter;
      this.resetAdapter();
    }
    if (this.connectPromise) {
      const connected = await this.connectPromise;
      if (!requireOwner || connected.commandLaneKind === 'owner') return connected;
      this.resetAdapter();
    }
    if (requireOwner && (!this.ownerRuntimeId || !this.ownerSigningKey)) {
      throw new RuntimeAdapterError(
        'E_UNAUTHORIZED',
        'durable custody payment retry requires the daemon vault-owner binding',
      );
    }

    const adapter = new RemoteRuntimeAdapter();
    const authKey = this.currentAuthKey();
    this.connectPromise = adapter.connect({
      mode: 'remote',
      wsUrl: this.url,
      authKey,
      ...(this.ownerRuntimeId ? { runtimeId: this.ownerRuntimeId } : {}),
      ...(this.ownerRuntimeId && this.ownerSigningKey
        ? {
            ownerBindingSigner: ({ runtimeId, challenge, capability }) =>
              this.ownerSigningKey!.sign(
                buildRuntimeAdapterOwnerBindingDigest(runtimeId, challenge, capability),
              ).serialized.toLowerCase(),
          }
        : {}),
      requestTimeoutMs: 12_000,
    }).then(async () => {
      if (requireOwner) await adapter.ensureOwnerCommandLane();
      this.adapter = adapter;
      return adapter;
    }).finally(() => {
      this.connectPromise = null;
    });
    return await this.connectPromise;
  }

  private async withAdapter<T>(
    requireOwner: boolean,
    operation: (adapter: RemoteRuntimeAdapter) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const adapter = await this.connect(requireOwner);
      try {
        return await operation(adapter);
      } catch (error) {
        if (!(error instanceof RuntimeAdapterError) || error.code !== 'E_UNAUTHORIZED' || attempt > 0) throw error;
        this.resetAdapter();
      }
    }
    throw new RuntimeAdapterError('E_UNAUTHORIZED', 'custody daemon authentication failed');
  }

  async getFrameReceipts(params: {
    fromHeight: number;
    toHeight?: number;
    limit?: number;
    entityId?: string;
    eventNames?: string[];
  }): Promise<DaemonFrameReceiptResponse> {
    return await this.withAdapter(false, adapter => adapter.read('frame-receipts', params));
  }

  async findRoutes(params: {
    sourceEntityId: string;
    targetEntityId: string;
    tokenId: number;
    amount: string;
  }): Promise<{ routes: DaemonRoute[] }> {
    const query = {
      sourceEntityId: normalizeEntityId(params.sourceEntityId, 'custody route source entity is invalid'),
      targetEntityId: normalizeEntityId(params.targetEntityId, 'custody route target entity is invalid'),
      tokenId: normalizePositiveInteger(params.tokenId, 'custody route tokenId must be positive'),
      amount: normalizePositiveAmount(params.amount),
    };
    return await this.withAdapter(false, adapter => adapter.read<RuntimeAdapterPaymentRoutesResponse>('payment-routes', query));
  }

  private async waitForInitiatedEvent(
    accepted: RuntimeAdapterSendResult,
    expected: {
      sourceEntityId: string;
      targetEntityId: string;
      tokenId: number;
      amount: string;
      route: string[];
      description?: string;
    },
  ): Promise<{ hashlock: string; startedAtMs?: number }> {
    const acceptedHeight = Math.max(1, Math.floor(Number(accepted.height || 0)));
    let cursor = accepted.status === 'observed' ? acceptedHeight : acceptedHeight + 1;
    const deadline = Date.now() + COMMIT_WAIT_MS;
    while (Date.now() < deadline) {
      if (accepted.receipt?.id) {
        const receipt = await this.withAdapter(false, adapter =>
          adapter.read<{ status: string }>(`receipt/${encodeURIComponent(accepted.receipt!.id)}`));
        if (receipt.status === 'expired') {
          throw new RuntimeAdapterError('E_INTERNAL', 'custody payment command expired before durable commit');
        }
      }
      const page = await this.getFrameReceipts({
        fromHeight: cursor,
        limit: 100,
        entityId: expected.sourceEntityId,
        eventNames: ['HtlcInitiated'],
      });
      for (const frame of page.receipts) {
        for (const log of frame.logs) {
          const data = eventData(log);
          if (
            log.message !== 'HtlcInitiated'
            || String(data['entityId'] ?? data['fromEntity'] ?? '').toLowerCase() !== expected.sourceEntityId
            || String(data['toEntity'] ?? '').toLowerCase() !== expected.targetEntityId
            || Number(data['tokenId']) !== expected.tokenId
            || String(data['amount'] ?? '') !== expected.amount
            || String(data['description'] ?? '') !== String(expected.description ?? '')
          ) continue;
          const route = Array.isArray(data['route']) ? data['route'].map(String) : [];
          if (route.length !== expected.route.length || route.some((entry, index) => entry.toLowerCase() !== expected.route[index])) {
            throw new RuntimeAdapterError('E_INTERNAL', 'committed custody payment route does not match durable intent');
          }
          const hashlock = String(data['hashlock'] ?? '').toLowerCase();
          if (!HASHLOCK_PATTERN.test(hashlock)) {
            throw new RuntimeAdapterError('E_INTERNAL', 'committed custody payment event is missing its hashlock');
          }
          const startedAtMs = Number(data['startedAtMs']);
          return {
            hashlock,
            ...(Number.isSafeInteger(startedAtMs) && startedAtMs > 0 ? { startedAtMs } : {}),
          };
        }
      }
      if (page.toHeight >= cursor) cursor = page.toHeight + 1;
      await sleep(COMMIT_POLL_MS);
    }
    throw new RuntimeAdapterError('E_COMMAND_PENDING', 'custody payment is not durably committed yet', true, COMMIT_POLL_MS);
  }

  async queuePayment(params: DaemonQueuePaymentParams): Promise<DaemonQueuePaymentResult> {
    const sourceEntityId = normalizeEntityId(params.sourceEntityId, 'custody payment source entity is invalid');
    const signerId = normalizeSignerId(params.signerId);
    const targetEntityId = normalizeEntityId(params.targetEntityId, 'custody payment target entity is invalid');
    const tokenId = normalizePositiveInteger(params.tokenId, 'custody payment tokenId must be positive');
    const amount = normalizePositiveAmount(params.amount);
    const route = normalizeRoute(params.route, sourceEntityId, targetEntityId);
    const description = normalizeDescription(params.description);
    const mode = params.mode ?? 'htlc';
    const commandId = String(params.commandId || '').trim();
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(commandId)) {
      throw new RuntimeAdapterError('E_BAD_QUERY', 'custody payment commandId must be a stable withdrawal intent id');
    }

    const data = { targetEntityId, tokenId, amount: BigInt(amount), route, ...(description ? { description } : {}) };
    const entityTx: EntityTx = mode === 'direct'
      ? { type: 'directPayment', data }
      : { type: 'htlcPayment', data };
    const input: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [{ entityId: sourceEntityId, signerId, entityTxs: [entityTx] }],
    };

    const accepted = await this.withAdapter(true, async adapter => {
      const commandSequence = params.commandSequence
        ?? normalizePositiveInteger(adapter.nextCommandSequence, 'custody owner command frontier is unavailable');
      await params.onCommandPrepared?.(commandSequence);
      daemonLog.info('payment.send', { commandId, commandSequence, status: 'sending' });
      const result = await adapter.send(input, { commandId, commandSequence });
      return { result, commandSequence };
    });
    daemonLog.info('payment.accepted', {
      commandId,
      commandSequence: accepted.commandSequence,
      status: accepted.result.status ?? 'pending',
      requestId: accepted.result.receipt?.id,
    });

    const committed = mode === 'htlc'
      ? await this.waitForInitiatedEvent(accepted.result, {
          sourceEntityId,
          targetEntityId,
          tokenId,
          amount,
          route,
          ...(description ? { description } : {}),
        })
      : {};
    return {
      sourceEntityId,
      signerId,
      targetEntityId,
      tokenId,
      amount,
      route,
      mode,
      ...(description ? { description } : {}),
      ...committed,
      commandId,
      commandSequence: accepted.commandSequence,
    };
  }
}
