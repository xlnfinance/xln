# Advisor scorecard

Compact routing memory for external and subagent reviews. Scores measure this
repository's observed audit value, not general model quality.

## Selection

- Score = precision 30 + xln consensus reasoning 30 + rare-path coverage 20 +
  reproducible evidence 15 + efficiency 5.
- Weight: 85-100 = 4, 70-84 = 2, below 70 = 1. Reserve 25% of selections for
  a new model or independent family; never use one family as its own quorum.
- Update only after the primary agent verifies or disproves a concrete claim.
  Store the verdict and decisive evidence, not full transcripts.

## Current evidence

| Advisor | Score / weight | Decisive evidence |
|---|---:|---|
| Codex subagent | 96 / 4 | Found non-active direct-proposal bypass, same-J-range returned-claim race, and the 1000-claim preparation DoS. |
| Opus | 94 / 4 | Found permanent disputed Account mempool DoS and unauthenticated daemon shutdown; both reproduced and fixed. |
| Cursor / Grok 4.5 High | 92 / 4 | Found CLI serialization and signer-context races; approved the bounded PREPARE-CLAIM lifecycle after independent path review. |
| OpenCode / GLM | 67 / 1 | Correctly rechecked three remediation areas, but misclassified PREPARE-CLAIM as safe; release determinism disproved it. |

Last updated: 2026-08-10, PREPARE-CLAIM-01 remediation verified.
