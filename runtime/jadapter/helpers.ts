/**
 * JAdapter Helpers
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import type { Depository } from '../../jurisdictions/typechain-types/Depository';
import type { EntityProvider } from '../../jurisdictions/typechain-types/EntityProvider';
import type { JEvent, JEventCallback } from './types';

// Hardhat account #0 (publicly known test key)
export const DEFAULT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export function computeAccountKey(entity1: string, entity2: string): string {
  const [left, right] = entity1.toLowerCase() < entity2.toLowerCase()
    ? [entity1, entity2]
    : [entity2, entity1];
  return ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]);
}

export function entityIdToAddress(entityId: string): string {
  const normalized = entityId.toLowerCase().replace('0x', '').padStart(64, '0');
  return ethers.getAddress('0x' + normalized.slice(-40));
}

export function setupContractEventListeners(
  depository: Depository,
  entityProvider: EntityProvider,
  eventCallbacks: Map<string, Set<JEventCallback>>,
  anyCallbacks: Set<JEventCallback>
) {
  const depositoryEvents = [
    'ReserveUpdated',
    'SecretRevealed',
    'DisputeStarted',
    'DisputeFinalized',
    'InsuranceRegistered',
    'InsuranceClaimed',
    'DebtCreated',
    'DebtEnforced',
    'CooperativeClose',
  ];

  for (const eventName of depositoryEvents) {
    // Use any cast to bypass strict typechain event typing
    (depository as any).on(eventName, (...args: any[]) => {
      const event = args[args.length - 1];
      const jEvent: JEvent = {
        name: eventName,
        args: event.args ? Object.fromEntries(event.args.entries()) : {},
        blockNumber: event.blockNumber ?? 0,
        blockHash: event.blockHash ?? '0x',
        transactionHash: event.transactionHash ?? '0x',
      };

      eventCallbacks.get(eventName)?.forEach(cb => cb(jEvent));
      anyCallbacks.forEach(cb => cb(jEvent));
    });
  }

  const entityProviderEvents = [
    'EntityRegistered',
    'NameAssigned',
    'NameTransferred',
    'GovernanceEnabled',
  ];

  for (const eventName of entityProviderEvents) {
    // Use any cast to bypass strict typechain event typing
    (entityProvider as any).on(eventName, (...args: any[]) => {
      const event = args[args.length - 1];
      const jEvent: JEvent = {
        name: eventName,
        args: event.args ? Object.fromEntries(event.args.entries()) : {},
        blockNumber: event.blockNumber ?? 0,
        blockHash: event.blockHash ?? '0x',
        transactionHash: event.transactionHash ?? '0x',
      };

      eventCallbacks.get(eventName)?.forEach(cb => cb(jEvent));
      anyCallbacks.forEach(cb => cb(jEvent));
    });
  }
}
