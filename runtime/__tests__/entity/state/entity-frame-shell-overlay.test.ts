import { describe, expect, test } from 'bun:test';

import {
  commitEntityFrameCandidateState,
  createEntityFrameCandidateState,
} from '../../../entity/state-clone';
import {
  EntityAccountCandidateMap,
  getEntityAccountForWrite,
} from '../../../entity/state/persistent-account-map';
import {
  EntityCollectionCandidateMap,
  getEntityCollectionValueForWrite,
  PersistentEntityCollectionMap,
} from '../../../entity/state/persistent-collection-map';
import { entity, makeJurisdiction, makeState } from '../../helpers/cross-j';

describe('Entity frame shell overlay', () => {
  test('growing collection reads stay clean and explicit writes fork one sealed leaf', () => {
    type Entry = { status: string; nested: { count: number } };
    const base = PersistentEntityCollectionMap.from<Entry>(new Map([
      ['route', { status: 'open', nested: { count: 1 } }],
    ]));
    const baseRoot = base.rootHash();
    const candidate = new EntityCollectionCandidateMap(
      base,
      value => ({ ...value, nested: { ...value.nested } }),
    );

    const observed = candidate.get('route');
    if (!observed) throw new Error('TEST_ENTITY_COLLECTION_READ_MISSING');
    expect(candidate.rootHash()).toBe(baseRoot);
    expect(() => { observed.nested.count = 2; }).toThrow();

    const writable = getEntityCollectionValueForWrite(candidate, 'route');
    if (!writable) throw new Error('TEST_ENTITY_COLLECTION_WRITE_MISSING');
    writable.nested.count = 2;
    expect(candidate.rootHash()).not.toBe(baseRoot);
    expect(base.get('route')?.nested.count).toBe(1);
    expect(candidate.get('route')?.nested.count).toBe(2);
  });

  test('isolates bounded fields and leaves every growing graph untouched until write', () => {
    const owner = entity('61');
    const counterparty = entity('62');
    const source = makeState(
      owner,
      'validator',
      makeJurisdiction('entity-shell-overlay', 31_337, 'a1', 'a2'),
      counterparty,
    );
    source.nonces.set('before', 1);
    source.reserves.set(1, 10n);

    const sourceAccounts = source.accounts;
    const sourceAccount = source.accounts.get(counterparty);
    if (!sourceAccount) throw new Error('TEST_ENTITY_SHELL_ACCOUNT_MISSING');

    const candidate = createEntityFrameCandidateState(source);
    if (!(candidate.accounts instanceof EntityAccountCandidateMap)) {
      throw new Error('TEST_ENTITY_SHELL_ACCOUNT_OVERLAY_MISSING');
    }
    if (!(candidate.htlcRoutes instanceof EntityCollectionCandidateMap)) {
      throw new Error('TEST_ENTITY_SHELL_HTLC_OVERLAY_MISSING');
    }

    expect(candidate.accounts.stats()).toEqual({ base: 1, changed: 0, deleted: 0 });
    expect(candidate.accounts.get(counterparty)).toBe(sourceAccount);
    expect(candidate.nonces).not.toBe(source.nonces);
    expect(candidate.reserves).not.toBe(source.reserves);
    expect(candidate.profile).not.toBe(source.profile);

    candidate.nonces.set('candidate', 2);
    candidate.reserves.set(1, 11n);
    candidate.profile.name = 'candidate';
    const writable = getEntityAccountForWrite(candidate.accounts, counterparty);
    if (!writable) throw new Error('TEST_ENTITY_SHELL_ACCOUNT_WRITE_MISSING');
    writable.status = 'disputed';

    expect(source.nonces.has('candidate')).toBe(false);
    expect(source.reserves.get(1)).toBe(10n);
    expect(source.profile.name).not.toBe('candidate');
    expect(sourceAccount.status).not.toBe('disputed');
    expect(candidate.accounts.stats().changed).toBe(1);

    const committed = commitEntityFrameCandidateState(candidate);
    expect(committed.accounts).not.toBe(sourceAccounts);
    expect(committed.accounts.get(counterparty)?.status).toBe('disputed');
    expect(source.accounts.get(counterparty)?.status).not.toBe('disputed');
  });
});
