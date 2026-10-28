import { expect, test } from 'bun:test';
import { AbiCoder, keccak256 } from 'ethers';
import { refreshDisputeSecretArguments } from '../../../entity/dispute-secret-arguments';
import { BATCH_ABI } from '../../../protocol/dispute/proof-body';
import { encodeDeltaTransformerArgs, wrapTransformerArgs } from '../../../protocol/dispute/arguments';
import { encodeInt512 } from '../../../protocol/crypto/abi-money';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { addr, entity, makeJurisdiction, makeState } from '../../helpers/cross-j';

test('N8 secrets follow exact clauses, preserve swap arguments, and ignore unrelated paybook evidence', () => {
  const state = makeState(entity('11'), addr('31'), makeJurisdiction('secret', 31337, '21', '22'), entity('22'));
  const coder = AbiCoder.defaultAbiCoder();
  const secrets = ['61', '62', '63'].map(byte => entity(byte));
  for (const secret of secrets) {
    const hashlock = hashHtlcSecret(secret);
    state.paybook.entries.set(hashlock, { hashlock, secret, inboundEntity: entity('22'), createdTimestamp: 1 });
  }
  const body = {
    watchSeed: entity('33'),
    leftResponseSeconds: 10,
    rightResponseSeconds: 20,
    offdeltas: [encodeInt512(7n)],
    tokenIds: [1],
    transformers: [[], [secrets[1]!], [secrets[0]!]].map(payments => ({
      transformerAddress: addr('44'),
      allowances: [],
      encodedBatch: coder.encode(
        [BATCH_ABI],
        [
          {
            payment: payments.map(secret => ({
              deltaIndex: 0,
              amount: { negative: false, magnitude: 10n },
              revealedUntilTimestamp: 1000,
              hash: hashHtlcSecret(secret),
            })),
            swap: [],
            pull: [],
            loans: [],
          },
        ],
      ),
    })),
  };
  const existing = wrapTransformerArgs([encodeDeltaTransformerArgs([123], []), '0x', '0x']);
  const refreshed = refreshDisputeSecretArguments(body, existing, state, entity('22'), addr('44'));
  const expected = wrapTransformerArgs([
    encodeDeltaTransformerArgs([123], []),
    encodeDeltaTransformerArgs([], [secrets[1]!]),
    encodeDeltaTransformerArgs([], [secrets[0]!]),
  ]);
  expect(refreshed).toBe(expected);
  expect(refreshDisputeSecretArguments(body, refreshed, state, entity('22'), addr('44'))).toBe(expected);
  expect(refreshDisputeSecretArguments(body, existing, state, entity('55'), addr('44'))).toBe(existing);
  expect(refreshDisputeSecretArguments(body, existing, state, entity('22'), addr('55'))).toBe(existing);
  state.paybook.entries.get(hashHtlcSecret(secrets[1]!))!.secret = secrets[2];
  expect(refreshDisputeSecretArguments(body, '0x', state, entity('22'), addr('44'))).toBe(
    wrapTransformerArgs(['0x', '0x', encodeDeltaTransformerArgs([], [secrets[0]!])]),
  );
  // This exact digest is also asserted in the Rust regression.
  expect(keccak256(expected)).toBe('0x157f569c5db44516a7aef6bfd416997ee3799dc9dd469eb11d2ff7950e987997');
});
