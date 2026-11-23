# Locally retained USDC PoC evidence

The execution host retains these files under `.tmp/local-originals/` beside
this document. The SHA-256 values identify the original bytes.

## cross-swap.json

SHA-256 `1729d3adaa200dacd60c3026b0433337f5ed85a5d96d7938d05e0d4002ccdbb1`.

## external-payout.json

SHA-256 `854ed4e31272a324f589b86e90c8d3471565a2410a6339aeb74449e0f54ee09f`.

## funded-runtime-restore.json

SHA-256 `f0078abd542e832c914657d3eb9464f8d4904271e87bd2ce0a4941b906a090ef`.

## interrupted-recovery.json

SHA-256 `898ac92969bf77da1ca00edd2d53d93f8aa1b64af4a913a0f7bcd77bc1da2ea4`.

## operator-capital-plan.json

SHA-256 `f04792c130e258e3ed0618bd40578730bf038c606500c91f9c94abde062122ba`.

## operator-funding-approval.json

SHA-256 `9e6affbbdef68ac96b6b7bc7c183589ee3a571b72d3b8466767c7476a7b6b2eb`.

## operator-funding-authorization.json

SHA-256 `3228934982e0a2fb7a17d61039f347981bff328c2cf716fc8bd9d13bae7d0f73`.

## operator-funding-executor.json

SHA-256 `ff93d7faa9e3ea057e7384555e9aada16768db424c60c38fe46c2ab097992545`.

## operator-funding-observation-verification.json

SHA-256 `1627c442c2da93a46f113f28290d22069f557dfdf78badc4ef6301e29aec3652`.

## operator-funding-public.json

SHA-256 `6a1e605dd0ad64669c7e1de7d9119be80f626533dd248b30b5987ed91be98666`.

| Chain            | Funder nonce | Transaction hash                                                     |
| ---------------- | -----------: | -------------------------------------------------------------------- |
| Ethereum Sepolia |          106 | `0x7cd0994dd0bad003120003800575af479f6991d719e973337143bd1aabfb8e59` |
| Ethereum Sepolia |          107 | `0x5f7752162dbbf7b166d491a76c84897db3d49f21c01effd0fc2a2118fd5d69ff` |
| Ethereum Sepolia |          108 | `0x009da7bb4d077e2468a2b3579731fe5b6fa7de02c114d28d4adf731385182638` |
| Arbitrum Sepolia |           30 | `0x82d93509c904bea069b8135f60ba1b20923eaa2151b204ac2e41ebdb4ff27a17` |
| Arbitrum Sepolia |           31 | `0x462aace55c2024fc218ab5ae4346fb49168201b132a92649f4f3721206dab9a6` |
| Arbitrum Sepolia |           32 | `0x27fe1e25b7a004ca143e94974340ed5758845851f15a5e4cfcedaa25eb213252` |

## public-financial-cli.json

SHA-256 `589db333d6ab6564459554d330ed6b7349e91328f19e2432514f1d7bee9a9a27`.

## public-preflight.json

SHA-256 `2903233ebdb8b4c8efd8bcc3bbabc248582cb6005ca0392b1894455245361778`.

## Ticket 14 campaign

Files prefixed `ticket14-fresh-c5knyz-` preserve preparation, funding,
verification of both completed runs and the run 3 stop. The run verification
files are `ticket14-fresh-c5knyz-run-1-verified.json` and
`ticket14-fresh-c5knyz-run-2-verified.json`. The
[ticket](../../../.scratch/ts-usdc-cross-j-poc/issues/14-five-run-and-recovery-gas-plan.md#two-run-acceptance)
records the transaction hashes, payouts and fees.

## Ticket 15 earlier attempts

`ticket-15-preflight-20261120.json` and the files prefixed
`ticket15-fresh-r6lbjj-` and `ticket15-warm-fadkvt-` preserve the preflight,
funding and interrupted attempts. The
[completed public proof](../../../.scratch/ts-usdc-cross-j-poc/issues/15-clean-candidate-public-proof.md#completed-public-proof-on-1ce560d95)
links the retained receipts, signed Cross-J trace and WAL verification.

## Ticket 15 clean candidate verification

Verified on 2026-11-20 at commit `c77866445c2fcf5a075fe7394196e423f381c3c1`.
The CLI reported candidate digest
`fdce06be709709d229f6f1a3d9ae1039bf03aa19dc4b848c4ef7cefd55fdd6b1`.
The independent checkout had no Git changes before or after verification.
Bun 1.4.3 installed dependencies offline with `--frozen-lockfile`.

| Check                                                                | Result                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| Focused storage, fee, authority, quote, tariff and RPC suites        | 112 tests, 549 assertions                                    |
| `usdc-supervised-run.test.ts`                                        | 1 test, 80 assertions, 125.83 s                              |
| `usdc-session/status.test.ts` and `usdc-session/stop-report.test.ts` | 2 tests, 31 assertions, 96.12 s                              |
| `usdc-public-journey.test.ts`                                        | 1 test, 70 assertions, 125.17 s                              |
| `core/scenarios/usdc-poc/recovery-run.ts`                            | 3 cases, 8 Runtime interruptions                             |
| Deployment TypeScript and `bun run check`                            | Passed, including 3 short, 38 source and 10 soundcheck gates |

The financial tests held the shared capacity-one stand lock. The supervised
Anvil run bound its completion report to this SHA and digest. It deposited
1,000,000 units, paid 899,801 units externally and reconciled the original three
source and two target receipts. The five-run test proved an earlier run without
another debit. The recovery matrix covered accepted effects, partial then full
execution, and expired partial clear. All execution used local Anvil chains.

On a new checkout, run `bun run contracts:sync` before the aggregate check and
install `forge-std` for Foundry. The first artifact drift check reported two
trees of empty directories made by the TypeChain generator. All 109 generated
TypeChain and contract JSON files matched the committed files byte for byte.
The aggregate check reached the Foundry gate after artifact generation and
required `forge-std`, which is ignored by Git in this repository. The successful
run used `forge-std` commit `8e40513d678f392f398620b3ef2b418648b33e89`.
The run used process-local Git configuration for temporary test commits.
