import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import { readFileSync } from 'node:fs';

import { expect, test } from 'bun:test';

import { createHmac } from 'crypto';

import { computeAddress, hexlify, keccak256, recoverAddress, SigningKey, toUtf8Bytes } from 'ethers';

import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';

import {
  deriveRuntimeAdapterCapabilityToken,
  resolveRuntimeAdapterAuthSeed,
  verifyRuntimeAdapterAuthCredential,
  verifyRuntimeAdapterAuthKey,
} from '../../../api/runtime-adapter/security/auth';

import {
  decodeRuntimeAdapterBrowserMessage,
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
  runtimeAdapterMaxMessageBytes,
} from '../../../api/runtime-adapter/codec';

import { EmbeddedRuntimeAdapter } from '../../../api/runtime-adapter/embedded';

import { RemoteRuntimeAdapter } from '../../../api/runtime-adapter/remote';

import { verifyRuntimeAdapterServerIdentity } from '../../../api/runtime-adapter/security/server-identity';

import { buildRuntimeAdapterOwnerBindingDigest } from '../../../api/runtime-adapter/security/owner-binding';

import { signRuntimeAdapterServerIdentity } from '../../../api/runtime-adapter/security/server-identity-signer';

import { resolveRuntimeAdapterRead } from '../../../api/runtime-adapter/resolve';
import {
  assertRuntimeAdapterGraphFrameWireBudget,
  type RuntimeAdapterGraphFrame,
} from '../../../api/runtime-adapter/read/graph-frame';

import { decryptRuntimeRecoveryBundle, deriveRuntimeRecoveryLookupKey } from '../../../storage/recovery/bundle/crypto';

import { broadcastRuntimeAdapterTick, handleRuntimeAdapterMessage } from '../../../api/runtime-adapter/server';

import {
  applyRuntimeAdapterCommandMarker,
  MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES,
} from '../../../runtime/command/frontier';

import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';

import {
  KEY_HEAD,
  STORAGE_SCHEMA_VERSION,
  hexBytes,
  keyLiveAccount,
  keyLiveEntity,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntity,
  keySnapshotManifest,
  normalizeEntityId,
  textBytes,
} from '../../../storage/keys';

import { projectAccountDoc, projectEntityCoreDoc, projectEntityReplicaCoreView } from '../../../storage/read/projections';

import {
  loadEntityAccountDocFromStorage,
  loadEntityStateFromStorage,
  loadEntityViewPageFromStorage,
} from '../../../storage/read/read';

import type {
  RuntimeDbLike,
  RuntimeFrame,
  StorageHead,
  StorageSnapshotManifest,
} from '../../../storage/types';

import type { AccountTx, Delta } from '../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityReplica } from '../../../entity/types';
import type { RuntimeReplica, RuntimeInput } from '../../../runtime/types';

import type { BookState } from '../../../orderbook';

import { DEFAULT_SPREAD_DISTRIBUTION, type OrderbookExtState } from '../../../orderbook/types';

import { createGossipLayer } from '../../../network/p2p/gossip';
import type { Profile } from '../../../entity/profile';

import { deriveSignerAddressSync, deriveSignerKeySync } from '../../../account/crypto';

import { buildCryptographicProfileFixture } from '../../helpers/cryptographic-profile';

const entityId = `0x${'aa'.repeat(32)}`;

const counterpartyId = `0x${'bb'.repeat(32)}`;

const adapterAuthChallenge = `0x${'41'.repeat(32)}`;

process.env['XLN_RADAPTER_AUTH_SEED'] = process.env['XLN_RADAPTER_AUTH_SEED'] || 'seed';

const decodeTestRuntimeAdapterMessage = <T>(raw: unknown): T =>
  (typeof raw === 'string'
    ? decodeRuntimeAdapterBrowserMessage(raw)
    : decodeRuntimeAdapterMessage(raw)) as unknown as T;

test('remote runtime adapter does not reconnect after unauthorized auth', async () => {
  const previousWebSocket = globalThis.WebSocket;
  let constructed = 0;

  class RejectingAuthWebSocket {
    static readonly OPEN = 1;

    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      constructed += 1;
      setTimeout(() => {
        this.readyState = RejectingAuthWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }

    send(raw: unknown): void {
      const request = decodeTestRuntimeAdapterMessage<{ id: string; op: string }>(raw);
      if (request.op !== 'auth') return;
      setTimeout(() => {
        this.onmessage?.({
          data: encodeRuntimeAdapterMessage({
            v: XLN_PROTOCOL_VERSION,
            inReplyTo: request.id,
            ok: false,
            error: {
              code: 'E_UNAUTHORIZED',
              message: 'bad auth',
              retryable: false,
            },
          }),
        });
      }, 0);
    }

    close(): void {
      this.readyState = 3;
      setTimeout(() => this.onclose?.(), 0);
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    RejectingAuthWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = new RemoteRuntimeAdapter();
    await expect(
      adapter.connect({
        mode: 'remote',
        wsUrl: 'ws://runtime-adapter.invalid/rpc',
        authKey: 'wrong',
        reconnectMaxMs: 1_000,
        requestTimeoutMs: 1_000,
      }),
    ).rejects.toThrow('bad auth');
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(adapter.status).toBe('error');
    expect(adapter.authLevel).toBe(null);
    expect(constructed).toBe(1);
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = previousWebSocket;
  }
});
