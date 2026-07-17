import { ethers } from 'ethers';

import type {
  EntityProviderActionIntent,
  EntityProviderExecutableActionKind,
  EntityProviderActionKind,
} from '../types/entity-provider-actions';
import {
  hashCancelEntityProviderActionHankoPayload,
  hashEntityTransferHankoPayload,
  hashReleaseControlSharesHankoPayload,
} from '../hanko/onchain-domain';

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const entityProviderActionKindCode = (kind: EntityProviderExecutableActionKind): 0 | 1 => {
  switch (kind) {
    case 'entityTransferTokens': return 0;
    case 'releaseControlShares': return 1;
    default: {
      const exhaustive: never = kind;
      throw new Error(`ENTITY_PROVIDER_ACTION_KIND_INVALID:${String(exhaustive)}`);
    }
  }
};

const requireIntentAddress = (value: unknown, code: string): string => {
  const raw = String(value ?? '').trim();
  if (!ethers.isAddress(raw) || raw.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${code}:${raw || 'missing'}`);
  }
  return ethers.getAddress(raw).toLowerCase();
};

const requireIntentUint = (value: unknown, code: string, allowZero = true): bigint => {
  if (
    typeof value !== 'bigint' ||
    value < 0n ||
    value > ethers.MaxUint256 ||
    (!allowZero && value === 0n)
  ) throw new Error(`${code}:${String(value)}`);
  return value;
};

export const recomputeEntityProviderActionHash = (
  intent: Omit<EntityProviderActionIntent, 'actionHash'> | EntityProviderActionIntent,
): string => {
  const domain = {
    chainId: intent.chainId,
    entityProviderAddress: intent.entityProviderAddress,
    boardEpoch: intent.boardEpoch,
  };
  if (intent.payload.kind === 'entityTransferTokens') {
    return hashEntityTransferHankoPayload(domain, {
      entityNumber: intent.entityNumber,
      ...intent.payload.transfer,
      actionNonce: intent.actionNonce,
    }).toLowerCase();
  }
  if (intent.payload.kind === 'releaseControlShares') {
    return hashReleaseControlSharesHankoPayload(domain, {
      entityNumber: intent.entityNumber,
      ...intent.payload.release,
      actionNonce: intent.actionNonce,
    }).toLowerCase();
  }
  return hashCancelEntityProviderActionHankoPayload(domain, {
    entityNumber: intent.entityNumber,
    actionNonce: intent.actionNonce,
    ...intent.payload.cancel,
  }).toLowerCase();
};

export const assertEntityProviderActionIntent = (
  intent: EntityProviderActionIntent,
  trusted: {
    chainId: number | bigint;
    entityProviderAddress: string;
    depositoryAddress: string;
    entityId?: string;
    expectedKind?: EntityProviderActionKind;
    boardEpoch?: number | bigint;
  },
): void => {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new Error('ENTITY_PROVIDER_ACTION_INTENT_INVALID');
  }
  const trustedChainId = BigInt(trusted.chainId);
  const trustedProvider = ethers.isAddress(trusted.entityProviderAddress)
    ? ethers.getAddress(trusted.entityProviderAddress).toLowerCase()
    : '';
  const trustedDepository = ethers.isAddress(trusted.depositoryAddress)
    ? ethers.getAddress(trusted.depositoryAddress).toLowerCase()
    : '';
  if (
    trustedChainId <= 0n ||
    trustedChainId > ethers.MaxUint256 ||
    !trustedProvider ||
    trustedProvider === ZERO_ADDRESS ||
    !trustedDepository ||
    trustedDepository === ZERO_ADDRESS
  ) {
    throw new Error('ENTITY_PROVIDER_ACTION_TRUSTED_DOMAIN_INVALID');
  }
  if (
    intent.version !== 1 ||
    typeof intent.entityId !== 'string' ||
    typeof intent.entityNumber !== 'bigint' ||
    intent.entityNumber <= 0n ||
    intent.entityNumber > ethers.MaxUint256 ||
    intent.entityId.toLowerCase() !== ethers.zeroPadValue(ethers.toBeHex(intent.entityNumber), 32).toLowerCase() ||
    (trusted.entityId !== undefined && intent.entityId.toLowerCase() !== trusted.entityId.toLowerCase()) ||
    intent.chainId !== trustedChainId ||
    typeof intent.entityProviderAddress !== 'string' ||
    intent.entityProviderAddress.toLowerCase() !== trustedProvider ||
    typeof intent.boardEpoch !== 'bigint' ||
    intent.boardEpoch < 0n ||
    intent.boardEpoch > ethers.MaxUint256 ||
    (trusted.boardEpoch !== undefined && intent.boardEpoch !== BigInt(trusted.boardEpoch)) ||
    typeof intent.actionNonce !== 'bigint' ||
    intent.actionNonce <= 0n ||
    intent.actionNonce > ethers.MaxUint256 ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation <= 0 ||
    !Number.isSafeInteger(intent.createdAt) ||
    intent.createdAt < 0 ||
    typeof intent.actionHash !== 'string' ||
    !BYTES32.test(intent.actionHash.toLowerCase()) ||
    !intent.payload ||
    typeof intent.payload !== 'object' ||
    Array.isArray(intent.payload)
  ) {
    throw new Error('ENTITY_PROVIDER_ACTION_INTENT_INVALID');
  }
  if (trusted.expectedKind && intent.payload.kind !== trusted.expectedKind) {
    throw new Error(
      `ENTITY_PROVIDER_ACTION_KIND_MISMATCH:${intent.payload.kind}:${trusted.expectedKind}`,
    );
  }
  if (intent.payload.kind === 'entityTransferTokens') {
    requireIntentAddress(intent.payload.transfer?.to, 'ENTITY_PROVIDER_ACTION_RECIPIENT_INVALID');
    requireIntentUint(intent.payload.transfer?.tokenId, 'ENTITY_PROVIDER_ACTION_TOKEN_ID_INVALID');
    requireIntentUint(intent.payload.transfer?.amount, 'ENTITY_PROVIDER_ACTION_AMOUNT_INVALID', false);
  } else if (intent.payload.kind === 'releaseControlShares') {
    const depository = requireIntentAddress(
      intent.payload.release?.depositoryAddress,
      'ENTITY_PROVIDER_ACTION_DEPOSITORY_INVALID',
    );
    if (depository !== trustedDepository) {
      throw new Error(`ENTITY_PROVIDER_ACTION_DEPOSITORY_MISMATCH:${depository}:${trustedDepository}`);
    }
    const control = requireIntentUint(
      intent.payload.release?.controlAmount,
      'ENTITY_PROVIDER_ACTION_CONTROL_AMOUNT_INVALID',
    );
    const dividend = requireIntentUint(
      intent.payload.release?.dividendAmount,
      'ENTITY_PROVIDER_ACTION_DIVIDEND_AMOUNT_INVALID',
    );
    if (control === 0n && dividend === 0n) {
      throw new Error('ENTITY_PROVIDER_ACTION_RELEASE_AMOUNT_EMPTY');
    }
    if (typeof intent.payload.release?.purpose !== 'string') {
      throw new Error('ENTITY_PROVIDER_ACTION_PURPOSE_INVALID:not-string');
    }
    const purposeBytes = new TextEncoder().encode(intent.payload.release.purpose).byteLength;
    if (purposeBytes > 1_024) {
      throw new Error(`ENTITY_PROVIDER_ACTION_PURPOSE_OVERSIZED:${purposeBytes}:1024`);
    }
  } else if (intent.payload.kind === 'cancelPendingAction') {
    const cancelledActionHash = String(intent.payload.cancel?.cancelledActionHash ?? '').toLowerCase();
    if (!BYTES32.test(cancelledActionHash) || cancelledActionHash === `0x${'00'.repeat(32)}`) {
      throw new Error(`ENTITY_PROVIDER_ACTION_CANCELLED_HASH_INVALID:${cancelledActionHash || 'missing'}`);
    }
    const cancelledActionKind = intent.payload.cancel?.cancelledActionKind;
    if (cancelledActionKind !== 0 && cancelledActionKind !== 1) {
      throw new Error(`ENTITY_PROVIDER_ACTION_CANCELLED_KIND_INVALID:${String(cancelledActionKind)}`);
    }
  } else {
    throw new Error(`ENTITY_PROVIDER_ACTION_KIND_INVALID:${String((intent.payload as { kind?: unknown }).kind)}`);
  }
  const recomputed = recomputeEntityProviderActionHash(intent);
  if (recomputed !== intent.actionHash.toLowerCase()) {
    throw new Error(`ENTITY_PROVIDER_ACTION_HASH_MISMATCH:${intent.actionHash}:${recomputed}`);
  }
};

export const assertEntityProviderActionJTxBinding = (
  jTx: {
    type: 'entityProviderTransfer' | 'entityProviderReleaseControlShares' | 'entityProviderCancelAction';
    entityId: string;
    data: { intent: EntityProviderActionIntent };
  },
  trusted: {
    chainId: number | bigint;
    entityProviderAddress: string;
    depositoryAddress: string;
  },
): void => {
  const expectedKind = jTx.type === 'entityProviderTransfer'
    ? 'entityTransferTokens'
    : jTx.type === 'entityProviderReleaseControlShares'
      ? 'releaseControlShares'
      : jTx.type === 'entityProviderCancelAction'
        ? 'cancelPendingAction'
        : (() => {
            const exhaustive: never = jTx.type;
            throw new Error(`ENTITY_PROVIDER_ACTION_JTX_TYPE_INVALID:${String(exhaustive)}`);
          })();
  assertEntityProviderActionIntent(jTx.data.intent, {
    ...trusted,
    entityId: jTx.entityId,
    expectedKind,
  });
};

export const assertEntityProviderActionResolutionReceipt = (
  intent: EntityProviderActionIntent,
  receipt: { name: string; args: Record<string, unknown> },
): void => {
  const entityId = String(receipt.args['entityId'] ?? '').toLowerCase();
  const actionNonce = BigInt(String(receipt.args['actionNonce'] ?? '-1'));
  if (entityId !== intent.entityId.toLowerCase() || actionNonce !== intent.actionNonce) {
    throw new Error(
      `ENTITY_PROVIDER_ACTION_RECEIPT_IDENTITY_MISMATCH:` +
      `${entityId}:${actionNonce.toString()}:${intent.entityId}:${intent.actionNonce.toString()}`,
    );
  }
  const executable = intent.payload.kind === 'cancelPendingAction'
    ? intent.payload.cancel
    : {
        cancelledActionHash: intent.actionHash,
        cancelledActionKind: entityProviderActionKindCode(intent.payload.kind),
      };
  if (receipt.name === 'EntityProviderActionExecuted') {
    if (
      String(receipt.args['actionHash'] ?? '').toLowerCase() !== executable.cancelledActionHash.toLowerCase() ||
      Number(receipt.args['actionKind']) !== executable.cancelledActionKind
    ) throw new Error(`ENTITY_PROVIDER_ACTION_NONCE_CONFLICT:${intent.entityId}:${intent.actionNonce.toString()}`);
    return;
  }
  if (receipt.name === 'EntityProviderActionCancelled') {
    if (
      String(receipt.args['cancelledActionHash'] ?? '').toLowerCase() !== executable.cancelledActionHash.toLowerCase() ||
      Number(receipt.args['cancelledActionKind']) !== executable.cancelledActionKind ||
      (
        intent.payload.kind === 'cancelPendingAction' &&
        String(receipt.args['cancelHash'] ?? '').toLowerCase() !== intent.actionHash.toLowerCase()
      )
    ) throw new Error(`ENTITY_PROVIDER_ACTION_NONCE_CONFLICT:${intent.entityId}:${intent.actionNonce.toString()}`);
    return;
  }
  throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_KIND_INVALID:${receipt.name}`);
};
