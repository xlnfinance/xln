import type { JurisdictionEvent } from '../types';
import { normalizeJurisdictionEvent } from '../jurisdiction/event-normalization';
import type { RawJEvent } from './helpers';
import { buildAccountSettledEvents, buildDebtEvent } from './j-event-financial-payloads';

const buildRegistryEvent = (event: RawJEvent): JurisdictionEvent[] => {
  const args = event.args;
  switch (event.name) {
    case 'FoundationBootstrapped':
      return [
        {
          type: 'FoundationBootstrapped',
          data: {
            recipient: String(args['recipient'] ?? ''),
            boardHash: String(args['boardHash'] ?? ''),
            controlTokenId: String(args['controlTokenId'] ?? ''),
            dividendTokenId: String(args['dividendTokenId'] ?? ''),
          },
        },
      ];
    case 'EntityRegistered':
      return [
        {
          type: 'EntityRegistered',
          data: {
            entityId: String(args['entityId'] ?? ''),
            entityNumber: String(args['entityNumber'] ?? ''),
            boardHash: String(args['boardHash'] ?? ''),
          },
        },
      ];
    case 'BoardActivated':
      return [
        {
          type: 'BoardActivated',
          data: {
            entityId: String(args['entityId'] ?? ''),
            previousBoardHash: String(args['previousBoardHash'] ?? ''),
            newBoardHash: String(args['newBoardHash'] ?? ''),
            previousBoardValidUntil: String(args['previousBoardValidUntil'] ?? ''),
          },
        },
      ];
    default:
      return [];
  }
};

const decodeTokenBalances = (value: unknown) =>
  Array.isArray(value)
    ? value.map(entry => {
        const record = entry as Record<string, unknown>;
        if (record['balance'] === undefined) {
          throw new Error('EXTERNAL_WALLET_SNAPSHOT_BALANCE_MISSING');
        }
        const tokenId = record['tokenId'];
        return {
          tokenAddress: String(record['tokenAddress'] ?? ''),
          ...(tokenId !== undefined ? { tokenId: Number(tokenId) } : {}),
          balance: String(record['balance']),
        };
      })
    : [];

const decodeAllowances = (value: unknown) =>
  Array.isArray(value)
    ? value.map(entry => {
        const record = entry as Record<string, unknown>;
        if (record['allowance'] === undefined) {
          throw new Error('EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_MISSING');
        }
        return {
          tokenAddress: String(record['tokenAddress'] ?? ''),
          spender: String(record['spender'] ?? ''),
          allowance: String(record['allowance']),
        };
      })
    : [];

const buildWalletEvent = (event: RawJEvent): JurisdictionEvent[] => {
  const args = event.args;
  if (event.name === 'ExternalWalletDelta') {
    return [
      {
        type: 'ExternalWalletDelta',
        data: {
          entityId: String(args['entityId'] ?? ''),
          owner: String(args['owner'] ?? ''),
          tokenAddress: String(args['tokenAddress'] ?? ''),
          ...(args['tokenId'] !== undefined ? { tokenId: Number(args['tokenId']) } : {}),
          ...(args['balanceDelta'] !== undefined ? { balanceDelta: String(args['balanceDelta']) } : {}),
          ...(args['spender'] !== undefined ? { spender: String(args['spender']) } : {}),
          ...(args['allowance'] !== undefined ? { allowance: String(args['allowance']) } : {}),
        },
      },
    ];
  }
  const tokenBalances = decodeTokenBalances(args['tokenBalances']);
  const allowances = decodeAllowances(args['allowances']);
  return [
    {
      type: 'ExternalWalletSnapshot',
      data: {
        entityId: String(args['entityId'] ?? ''),
        owner: String(args['owner'] ?? ''),
        ...(args['nativeBalance'] !== undefined ? { nativeBalance: String(args['nativeBalance']) } : {}),
        ...(tokenBalances.length > 0 ? { tokenBalances } : {}),
        ...(allowances.length > 0 ? { allowances } : {}),
      },
    },
  ];
};

const buildDisputeEvent = (event: RawJEvent): JurisdictionEvent[] => {
  const args = event.args;
  if (event.name === 'DisputeFinalized') {
    return [
      {
        type: 'DisputeFinalized',
        data: {
          sender: String(args['sender'] ?? ''),
          counterentity: String(args['counterentity'] ?? ''),
          initialNonce: String(args['initialNonce'] ?? ''),
          initialProofbodyHash: String(args['initialProofbodyHash'] ?? ''),
          finalProofbodyHash: String(args['finalProofbodyHash'] ?? ''),
          ...(args['batchNonce'] !== undefined ? { batchNonce: Number(args['batchNonce']) } : {}),
        },
      },
    ];
  }
  const disputeTimeout = Number(args['disputeTimeout']);
  if (!Number.isSafeInteger(disputeTimeout) || disputeTimeout <= 0) {
    throw new Error(
      `J_EVENT_DISPUTE_TIMEOUT_INVALID:block=${String(event.blockNumber)}:timeout=${String(args['disputeTimeout'])}`,
    );
  }
  return [
    {
      type: 'DisputeStarted',
      data: {
        sender: String(args['sender'] ?? ''),
        counterentity: String(args['counterentity'] ?? ''),
        nonce: String(args['nonce'] ?? ''),
        proofbodyHash: String(args['proofbodyHash'] ?? ''),
        watchSeed: String(args['watchSeed'] ?? '0x'),
        starterInitialArguments: String(args['starterInitialArguments'] ?? '0x'),
        starterIncrementedArguments: String(args['starterIncrementedArguments'] ?? '0x'),
        disputeTimeout,
        ...(args['batchNonce'] !== undefined ? { batchNonce: Number(args['batchNonce']) } : {}),
      },
    },
  ];
};

const buildBatchEvent = (event: RawJEvent): JurisdictionEvent[] => {
  const args = event.args;
  if (event.name === 'HankoBatchProcessed') {
    return [
      {
        type: 'HankoBatchProcessed',
        data: {
          entityId: String(args['entityId'] ?? ''),
          batchHash: String(args['batchHash'] ?? ''),
          nonce: Number(args['nonce']),
        },
      },
    ];
  }
  const operationType = Number(args['operationType']);
  const reason = Number(args['reason']);
  if (!Number.isSafeInteger(operationType) || operationType < 0 || operationType > 4) {
    throw new Error(`J_EVENT_BATCH_OPERATION_TYPE_INVALID:${String(args['operationType'])}`);
  }
  if (reason !== 0) {
    throw new Error(`J_EVENT_BATCH_SKIP_REASON_INVALID:${String(args['reason'])}`);
  }
  return [
    {
      type: 'BatchOperationSkipped',
      data: {
        entityId: String(args['entityId'] ?? ''),
        batchHash: String(args['batchHash'] ?? ''),
        nonce: Number(args['nonce']),
        operationType: operationType as 0 | 1 | 2 | 3 | 4,
        operationIndex: Number(args['operationIndex']),
        reason: 0,
      },
    },
  ];
};

const buildEntityProviderEvent = (event: RawJEvent): JurisdictionEvent[] => {
  const args = event.args;
  const key = event.name === 'EntityProviderActionExecuted' ? 'actionKind' : 'cancelledActionKind';
  const actionKind = Number(args[key]);
  if (actionKind !== 0 && actionKind !== 1) {
    const code =
      event.name === 'EntityProviderActionExecuted'
        ? 'J_EVENT_ENTITY_PROVIDER_ACTION_KIND_INVALID'
        : 'J_EVENT_ENTITY_PROVIDER_CANCEL_KIND_INVALID';
    throw new Error(`${code}:${String(args[key])}`);
  }
  return event.name === 'EntityProviderActionExecuted'
    ? [
        {
          type: 'EntityProviderActionExecuted',
          data: {
            entityId: String(args['entityId'] ?? ''),
            actionNonce: String(args['actionNonce'] ?? ''),
            actionHash: String(args['actionHash'] ?? ''),
            actionKind,
          },
        },
      ]
    : [
        {
          type: 'EntityProviderActionCancelled',
          data: {
            entityId: String(args['entityId'] ?? ''),
            actionNonce: String(args['actionNonce'] ?? ''),
            cancelledActionHash: String(args['cancelledActionHash'] ?? ''),
            cancelledActionKind: actionKind,
            cancelHash: String(args['cancelHash'] ?? ''),
          },
        },
      ];
};

const rawEventToJEventPayloads = (event: RawJEvent, entityId: string): JurisdictionEvent[] => {
  switch (event.name) {
    case 'FoundationBootstrapped':
    case 'EntityRegistered':
    case 'BoardActivated':
      return buildRegistryEvent(event);
    case 'ReserveUpdated':
      return [
        {
          type: 'ReserveUpdated',
          data: {
            entity: String(event.args['entity'] ?? ''),
            tokenId: Number(event.args['tokenId']),
            newBalance: (event.args['newBalance'] ?? 0).toString(),
          },
        },
      ];
    case 'ExternalWalletSnapshot':
    case 'ExternalWalletDelta':
      return buildWalletEvent(event);
    case 'AccountSettled':
      return buildAccountSettledEvents(event, entityId);
    case 'SecretRevealed':
      return [
        {
          type: 'SecretRevealed',
          data: {
            hashlock: String(event.args['hashlock'] ?? ''),
            revealer: String(event.args['revealer'] ?? ''),
            secret: String(event.args['secret'] ?? ''),
          },
        },
      ];
    case 'DisputeStarted':
    case 'DisputeFinalized':
      return buildDisputeEvent(event);
    case 'DebtCreated':
    case 'DebtEnforced':
    case 'DebtForgiven':
      return buildDebtEvent(event);
    case 'HankoBatchProcessed':
    case 'BatchOperationSkipped':
      return buildBatchEvent(event);
    case 'EntityProviderActionExecuted':
    case 'EntityProviderActionCancelled':
      return buildEntityProviderEvent(event);
    default:
      return [];
  }
};

export const rawEventToJEvents = (event: RawJEvent, entityId: string): JurisdictionEvent[] => {
  const events = rawEventToJEventPayloads(event, entityId);
  if (events.length === 0) {
    throw new Error(`J_EVENT_CANONICAL_PAYLOAD_EMPTY:${event.name}`);
  }
  return events.map((jEvent, eventIndex) => {
    const candidate = {
      ...jEvent,
      ...(event.blockNumber !== undefined ? { blockNumber: event.blockNumber } : {}),
      ...(event.blockHash ? { blockHash: event.blockHash } : {}),
      ...(event.transactionHash ? { transactionHash: event.transactionHash } : {}),
      ...(event.logIndex !== undefined ? { logIndex: event.logIndex } : {}),
      ...(events.length > 1 ? { eventIndex } : {}),
    };
    const normalized = normalizeJurisdictionEvent(candidate);
    if (!normalized) {
      throw new Error(
        `J_EVENT_CANONICAL_PAYLOAD_INVALID:${event.name}` +
          `:block=${String(event.blockNumber ?? 'unknown')}` +
          `:tx=${String(event.transactionHash ?? 'unknown')}`,
      );
    }
    return normalized;
  });
};
