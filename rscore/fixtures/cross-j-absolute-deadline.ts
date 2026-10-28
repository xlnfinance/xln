import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { safeStringify } from '../../core/protocol/serialization';
import { BATCH_ABI } from '../../core/protocol/dispute/proof-body';
import { encodeSignedAmount } from '../../core/protocol/crypto/abi-money';

// Independent expected ratios; TS and Rust consume identical signed ABI bytes.
const vectors = [
  { targetRole: false, start: 110, deadline: 120, revealedAt: 120, claimed: 0, ratio: 65535, expected: 65535 },
  { targetRole: true, start: 100, deadline: 353, revealedAt: 130, claimed: 0, ratio: 65535, expected: 65535 },
  { targetRole: true, start: 200, deadline: 353, revealedAt: 130, claimed: 0, ratio: 65535, expected: 65535 },
  { targetRole: true, start: 100, deadline: 353, revealedAt: 353, claimed: 17, ratio: 65535, expected: 65535 },
  { targetRole: true, start: 100, deadline: 353, revealedAt: 354, claimed: 17, ratio: 65535, expected: 17 },
  { targetRole: false, start: 110, deadline: 120, revealedAt: 121, claimed: 17, ratio: 65535, expected: 17 },
].map(vector => ({
  ...vector,
  encodedBatch: ethers.AbiCoder.defaultAbiCoder().encode(
    [ethers.ParamType.from(BATCH_ABI)],
    [
      {
        payment: [],
        swap: [],
        loans: [],
        pull: [
          {
            deltaIndex: 0,
            amount: encodeSignedAmount(100n),
            claimedRatio: vector.claimed,
            deadline: vector.deadline,
            targetRole: vector.targetRole,
            fullHash: `0x${'41'.repeat(32)}`,
            partialRoot: `0x${'42'.repeat(32)}`,
          },
        ],
      },
    ],
  ),
}));
writeFileSync(new URL('./cross-j-absolute-deadline.json', import.meta.url), `${safeStringify(vectors, 2)}\n`);
