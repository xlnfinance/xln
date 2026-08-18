import { describe, expect, test } from 'bun:test';

import {
  collectTouchedAccountIds,
  touchedAccountIdsForHankoSeal,
} from '../../../entity/consensus/account/touched-accounts';
import { sealHankoWitnessInState } from '../../../entity/consensus/input/hanko-witness';
import type { EntityState } from '../../../entity/types';
import type { RuntimeOverlayRecord } from '../../../types/account';
import { makeAccount } from '../../helpers/cross-j';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import type { HankoString } from '../../../types/hanko';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

const emptyState = (): EntityState => ({
  entityId,
  accounts: new EntityAccountCandidateMap(
    PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
  ),
} as unknown as EntityState);

describe('Hanko touched Account set', () => {
  test('unions proposable Accounts that have no storage-change', () => {
    const storageChanges: RuntimeOverlayRecord[] = [{
      family: 'entity',
      entityId,
    }];
    expect(collectTouchedAccountIds(entityId, [], storageChanges)).toEqual([]);
    expect(collectTouchedAccountIds(entityId, [counterpartyId], storageChanges))
      .toEqual([counterpartyId]);
  });

  test('Hanko seal includes a proposable Account with no storage-change', () => {
    const state = emptyState();
    const storageChanges: RuntimeOverlayRecord[] = [];
    const touched = touchedAccountIdsForHankoSeal(state, [counterpartyId], storageChanges);
    expect(touched).toEqual([counterpartyId]);
    expect(sealHankoWitnessInState(state, new Map(), 1, [])).toBe(0);
    expect(() => sealHankoWitnessInState(state, new Map(), 1, touched))
      .toThrow(`HANKO_SEAL_TOUCHED_ACCOUNT_MISSING:${counterpartyId}`);
  });

  test('claims a writable Account shell before attaching a post-quorum Hanko', () => {
    const account = makeAccount(entityId, counterpartyId);
    const frameHash = `0x${'33'.repeat(32)}`;
    const hanko = '0x01' as HankoString;
    account.currentFrame.stateHash = frameHash;
    account.lastOutboundFrameAck = {
      height: 0,
      counterpartyEntityId: counterpartyId,
      response: {
        kind: 'ack',
        fromEntityId: entityId,
        toEntityId: counterpartyId,
        domain: account.state.domain,
        disputeConfig: account.state.disputeConfig,
        ack: { height: 0, frameHash },
      },
    };
    const committed = PersistentEntityAccountMap.fromMap(
      new Map([[counterpartyId, account]]),
      entityId,
      computeEntityAccountValueHash,
    );
    const candidate = new EntityAccountCandidateMap(committed);
    const state = { entityId, accounts: candidate } as EntityState;
    const witness = new Map([[frameHash, {
      hanko,
      type: 'accountFrame' as const,
      entityHeight: 1,
      createdAt: 1,
    }]]);
    const consensusRootBeforeWitness = candidate.rootHash();

    expect(committed.get(counterpartyId)?.currentFrameHanko).toBeUndefined();
    expect(sealHankoWitnessInState(state, witness, 1, [counterpartyId])).toBe(1);
    const claimed = candidate.get(counterpartyId);
    expect(claimed?.currentFrameHanko).toBe(hanko);
    expect(candidate.getForWrite(counterpartyId)).toBe(claimed);
    expect(candidate.rootHash()).toBe(consensusRootBeforeWitness);
    expect(committed.get(counterpartyId)?.currentFrameHanko).toBeUndefined();
    expect(candidate.dirtyKeys()).toEqual(new Set([counterpartyId]));
  });
});
