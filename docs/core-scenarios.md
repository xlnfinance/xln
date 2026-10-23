# Core scenarios without a browser

Run `bun run test:scenarios:core` on Studio. It owns the stand lock and runs 19
scenarios against isolated RPC chains and databases, including three independent
Lending deadline cases. The profile excludes the visual grid, load stands and
the parked company product; the existing full release catalog remains intact.

| Boundary | Executable evidence |
| --- | --- |
| Pay, routing, fees, rollback | `ahb`, `lock-ahb`, `htlc-lazy`, `htlc-4hop` |
| Lost ACK, offline peer, reserve refill | `htlc-ack-recovery`, `hub-preserved-reserve-refill` |
| Same-J orders, fills, partial fills, cancel | `swap`, `swap-market` |
| Threshold Entity consensus | `multi-sig` |
| Settlement, rebalance, batch finality, disputes | `settle`, `rebalance`, `settle-rebalance`, `processbatch`, `dispute-lifecycle`, `dispute-transformer` |
| Signed savings, facility, fractional repayment, default, exact payout | `lending-lifecycle`, `lending-before-deadline`, `lending-after-deadline` |
| Cross-J dual-Runtime admission, publication and clear | `cross-j` |

The Lending scenarios verify both committed Account Hankos and matching Account
roots. They fund explicit bank IOUs, not fabricated collateral. A partial payment
of 1025 leaves principal 1500 with fractional interest retained; total repayment
is 2540 and the mature saver receives 5050. Requesting repayment of 20000 debits
only the outstanding amount. Default cannot create reserves or erase savings.

Before/exact/after maturity means signed frame timestamps at deadline minus one
millisecond, the deadline, and deadline plus one millisecond in independent runs.
The harness uses the canonical scheduled-wake constructor and accounts for the
Runtime's 100 ms scenario tick. This is controlled-time evidence, not an elapsed
hour. Each Lending scenario also verifies checkpoint plus ordered WAL reopen.

## Admission and crash regressions

`core/__tests__/finance/lending/policy/admission.test.ts` rejects malformed bank
terms and facilities before state mutation. `policy/production.test.ts` sends eight
bad policies through Runtime, verifies unchanged financial roots, retains eight
independently signed healthy commands, and checks exact WAL recovery. Actions
within one signed Entity command remain atomic.

Admission validates the complete raw command with the canonical EntityTx decoder
before binding the Account domain/nonce; injected derived fields and extra envelope
fields reject. Admission and recovery use the same current policy decoders. Governance still
belongs to the bank; a facility binds the existing Account domain and J nonce.
Decoder failures are typed sender rejections. State preparation and commitment
remain outside that catch boundary and retain fail-stop behavior.

`core/__tests__/storage/durability/lending-real-crash-recovery.test.ts` owns five
real SIGKILL cases: demand-rate renewal, fractional earnings, queued withdrawals,
restored liquidity, outbox redelivery and delayed early-close requests. Both
bilateral orientations are exercised. CI runs this file under the stand lock;
its five individual 60-second test deadlines remain unchanged.

## Immutable replay

The recorded checkpoint and ordered WAL are the oracle. Reuse them after a change
instead of repeating live setup:

```sh
bun run stand:status
bun run stand:run --reason core-replay --timeout-ms 180000 -- \
  bun core/scripts/checks/consensus/replay/recording.ts \
  --recording=/absolute/path/recording.json \
  --seed=determinism-test-seed-42 \
  --artifacts=/absolute/path/replay-output \
  --expected-evidence-hash=<original-evidence-hash>
```

Use the actual recording's seed and original digest. Decompress archived
`recording.json.gz` files first. The command verifies every recorded post-state
and outbox, compares TS W1/W4 roots and ordered events/effects, and requires the
original evidence digest. First divergence writes the exact frame evidence.

Receipts and immutable recordings for this change are in
`docs/evidence/core-scenarios-20261023/`.

## Limits of these proofs

The production catalogs contain 23 AccountTx and 66 EntityTx variants. Catalog
exhaustiveness is a type check, not semantic coverage of every possible input.
Focused unit vectors supplement the scenarios for authority, malformed inputs,
credit, holds, nonce/replay protection and recovery boundaries.

The Cross-J scenario is a topology/admission/clear probe; its label does not prove
every economic fill. Cross-J reducer tests cover full/partial/expiry/dispute
cases separately. Two EVM RPC chains do not establish native TVM financial
support. This profile does not certify browser flows, TPS or mainnet readiness.
