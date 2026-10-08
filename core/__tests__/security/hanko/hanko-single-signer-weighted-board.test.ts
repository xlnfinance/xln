/**
 * A single-signer board is any `{signer: w, threshold: t}` with w >= t
 * (`isSingleSignerBoard`). Manage -> Ownership forms a self-issued Entity with
 * `{signer: 2, threshold: 2}` because the default 1/1 board is the wallet's boot
 * Entity. Its id is the hash of exactly that board, so its own frame Hanko is a
 * lazy self-proof and must never ask the certified board registry.
 *
 * Regression: the TS single-signer claim hardcoded weight 1 / threshold 1. The
 * reconstructed 1/1 board missed the lazy id, fell into the registered branch
 * and threw CERTIFIED_BOARD_SIGNING_MEMBERSHIP_MISSING on the new Entity's first
 * frame, halting the browser Runtime. Rust already signs the configured shape
 * (`SigningIdentity` weight/threshold).
 */
import { expect, test } from 'bun:test';

import { signAccountFrame } from '../../../account/crypto';
import { isSingleSignerBoard } from '../../../entity/consensus/replica-validation';
import { generateLazyEntityId } from '../../../entity/factory';
import type { EntityState } from '../../../entity/types';
import {
  encodeSingleSignerEntityHankos,
  inspectHankoForHash,
  signEntityHashes,
  verifyHankoForHash,
} from '../../../hanko/signing';
import { createEmptyCertifiedBoardRegistryState } from '../../../jurisdiction/machine/board-registry';
import { createEmptyEnv } from '../../../runtime';
import { addReplica, makeJurisdiction, makeState, registerTestSigner } from '../../helpers/cross-j';

const SEED = 'formation-weighted-lazy-board';
const DIGEST = `0x${'5a'.repeat(32)}`;
const jurisdiction = makeJurisdiction('Formation', 31_337, 'd1', 'e1');

const formedLazyEntity = (signerId: string, weight: bigint, threshold: bigint): EntityState => {
  const entityId = generateLazyEntityId([{ name: signerId, weight }], threshold).toLowerCase();
  const state = makeState(entityId, signerId, jurisdiction);
  state.config = { ...state.config, threshold, shares: { [signerId]: weight } };
  // The formed Entity observes the stack's certified registry, which never
  // lists a lazy id: membership must not be required for its own Hanko.
  state.certifiedBoardState = createEmptyCertifiedBoardRegistryState(jurisdiction);
  return state;
};

test('weighted single-signer lazy Entity signs its own frame Hanko without registry membership', async () => {
  const env = createEmptyEnv(SEED);
  const signerId = registerTestSigner(env, SEED);
  const treasury = formedLazyEntity(signerId, 2n, 2n);
  const bootEntityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  expect(treasury.entityId).not.toBe(bootEntityId);
  expect(isSingleSignerBoard(treasury.config)).toBe(true);

  const signature = signAccountFrame(env, signerId, DIGEST);
  const [hanko] = encodeSingleSignerEntityHankos(env, treasury.entityId, signerId, [signature], treasury);
  expect(hanko).toBeDefined();

  const [claim] = (await inspectHankoForHash(hanko!, DIGEST)).claims;
  expect(claim).toMatchObject({ entityId: treasury.entityId, weights: [2n], threshold: 2n });
  expect(claim!.reconstructedBoardHash).toBe(treasury.entityId);
  await expect(
    verifyHankoForHash(hanko!, DIGEST, treasury.entityId, env, { observerState: treasury }),
  ).resolves.toEqual({ valid: true, entityId: treasury.entityId });

  // No explicit authority state: the hosted replica's config is the authority.
  addReplica(env, treasury, signerId);
  await expect(signEntityHashes(env, treasury.entityId, signerId, [DIGEST])).resolves.toEqual([hanko!]);
});

test('the retired 1/1 claim for the same key is not authority for the weighted Entity', async () => {
  const env = createEmptyEnv(SEED);
  const signerId = registerTestSigner(env, SEED);
  const treasury = formedLazyEntity(signerId, 2n, 2n);
  // Adversarial counterexample: the same key's 1/1 board Hanko (the bytes the
  // retired claim reconstructed) must not verify as the weighted Entity.
  const [bootHanko] = await signEntityHashes(env, generateLazyEntityId([signerId], 1n), signerId, [DIGEST]);
  await expect(
    verifyHankoForHash(bootHanko!, DIGEST, treasury.entityId, env, { observerState: treasury }),
  ).resolves.toEqual({ valid: false, entityId: null });
});

test('a key outside the formed board cannot produce the weighted Entity Hanko', () => {
  const env = createEmptyEnv(SEED);
  const signerId = registerTestSigner(env, SEED);
  const treasury = formedLazyEntity(signerId, 2n, 2n);
  const outsider = registerTestSigner(env, SEED, '2');
  const signature = signAccountFrame(env, outsider, DIGEST);
  expect(() => encodeSingleSignerEntityHankos(env, treasury.entityId, outsider, [signature], treasury))
    .toThrow(/SINGLE_SIGNER_HANKO_SIGNER_OUTSIDE_BOARD/);
});
