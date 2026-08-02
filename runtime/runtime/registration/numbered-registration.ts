import { ethers, type TransactionReceipt } from 'ethers';

import { generateNumberedEntityId } from '../../entity/factory';
import { canonicalJStackAddress } from '../../jurisdiction/adapter/stack-binding';
import type { JAdapter } from '../../jurisdiction/adapter/types';
import type { JurisdictionConfig } from '../../entity/types';
import type { RuntimeReplica } from '../types';
import { getLiveJAdapterEntries } from '../live-jadapters';

export const getTrustedRegistrationAdapter = (
  env: RuntimeReplica,
  jurisdiction: JurisdictionConfig,
): JAdapter => {
  const expectedChainId = Number(jurisdiction.chainId);
  if (!Number.isSafeInteger(expectedChainId) || expectedChainId <= 0) {
    throw new Error(`NUMBERED_REGISTRATION_CHAIN_ID_INVALID:${String(jurisdiction.chainId)}`);
  }
  const expectedDepository = canonicalJStackAddress(
    'numbered_registration:depository',
    jurisdiction.depositoryAddress,
  );
  const expectedEntityProvider = canonicalJStackAddress(
    'numbered_registration:entity_provider',
    jurisdiction.entityProviderAddress,
  );
  const candidates = new Set<JAdapter>();
  for (const { adapter } of getLiveJAdapterEntries(env)) {
    candidates.add(adapter);
  }
  const matches = [...candidates].filter((adapter) =>
    adapter.chainId === expectedChainId &&
    canonicalJStackAddress(
      'numbered_registration:adapter_depository',
      adapter.addresses.depository,
    ) === expectedDepository &&
    canonicalJStackAddress(
      'numbered_registration:adapter_entity_provider',
      adapter.addresses.entityProvider,
    ) === expectedEntityProvider
  );
  if (matches.length !== 1) {
    throw new Error(
      `NUMBERED_REGISTRATION_TRUSTED_ADAPTER_${matches.length === 0 ? 'MISSING' : 'AMBIGUOUS'}` +
      `:chainId=${expectedChainId}:depository=${expectedDepository}:entityProvider=${expectedEntityProvider}`,
    );
  }
  return matches[0]!;
};

export type NumberedEntityRegistration = Readonly<{
  entityNumber: number;
  entityId: string;
  logIndex: number;
}>;

export const parseNumberedEntityRegistrationReceipt = (
  jadapter: JAdapter,
  receipt: TransactionReceipt,
  expectedBoardHashes: readonly string[],
): NumberedEntityRegistration[] => {
  if (receipt.status !== 1) throw new Error('NUMBERED_REGISTRATION_RECEIPT_FAILED');
  const entityProviderAddress = canonicalJStackAddress(
    'numbered_registration:receipt_entity_provider',
    jadapter.addresses.entityProvider,
  );
  const events = receipt.logs
    .filter((log) => ethers.getAddress(log.address) === entityProviderAddress)
    .map((log) => ({ log, event: jadapter.entityProvider.interface.parseLog(log) }))
    .filter(({ event }) => event?.name === 'EntityRegistered');
  if (events.length !== expectedBoardHashes.length) {
    throw new Error(
      `NUMBERED_REGISTRATION_EVENT_COUNT_INVALID:expected=${expectedBoardHashes.length}:actual=${events.length}`,
    );
  }
  return events.map(({ event, log }, index) => {
    const expectedBoardHash = expectedBoardHashes[index]!;
    if (String(event!.args['boardHash']).toLowerCase() !== expectedBoardHash.toLowerCase()) {
      throw new Error(`NUMBERED_REGISTRATION_EVENT_BOARD_HASH_MISMATCH:index=${index}`);
    }
    const rawEntityNumber = event!.args['entityNumber'];
    const entityNumber = Number(rawEntityNumber);
    if (
      !Number.isSafeInteger(entityNumber) ||
      entityNumber <= 0 ||
      BigInt(entityNumber) !== BigInt(rawEntityNumber)
    ) {
      throw new Error(`NUMBERED_REGISTRATION_ENTITY_NUMBER_INVALID:${String(rawEntityNumber)}`);
    }
    if (
      index > 0 &&
      entityNumber !== Number(events[index - 1]!.event!.args['entityNumber']) + 1
    ) {
      throw new Error(`NUMBERED_REGISTRATION_EVENT_ORDER_INVALID:index=${index}`);
    }
    const entityId = generateNumberedEntityId(entityNumber);
    if (String(event!.args['entityId']).toLowerCase() !== entityId) {
      throw new Error(`NUMBERED_REGISTRATION_EVENT_ENTITY_ID_MISMATCH:index=${index}`);
    }
    return { entityNumber, entityId, logIndex: log.index };
  });
};
