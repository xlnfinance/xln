# BoardHankoRefresh boardEpoch key + c85598fe public release proof (2026-10-24)

Base SHA: `c85598fec78e9e52dc49df8bc8b8cb1870218516`.

## c85598fe public rollout (deployed 2026-10-24T09:01Z)

Stages: snapshot-before, preserve, deploy, ready (`c85598fe`), snapshot-after,
compare, served bytes and the original six wallet clicks all exited 0. The runner's
final status depended only on the wallet stage, and `compare.py` only formats
differences (it always exits 0), so recovery was re-proved independently:

- All 127 Account `accountStateRoot`s and compared financial fields (balances,
  pending, mempool, locks, proofHeader, rollback, status) are identical before and after.
- 3 Accounts moved h22 -> h23, one per hub (H1/H2/H3, same custody counterparty).
  Each new frame links the exact h22 `previousFrameHash` and carries 3
  `set_credit_limit` transactions equal to the prior canonical LEFT limits (RIGHT
  proposer grants LEFT). Frame hashes were recomputed with `assertAccountFrameHash`;
  `verifyHankoForHash(allowPreviousBoard:false)` verified both participant Entities
  per frame; the stored hub ACK matches digest, height and signature.
- The 3 historical Runtime frames are identical; all 7 served byte hashes match the build.
- Public six: import 31.4 s, faucet 4.2, reserve 5.1, Pay 6.5, credit 4.8, reload 20.2.

Open: the runner must fail-stop on each mandatory stage and `compare.py` must assert.
Import 31.4 s / reload 20.2 s is not acceptable latency; it is not closed.

## This change

- `board_hanko_refresh` and `counterparty_board_hanko_refresh_deadline` hooks, the
  Account `boardHankoRefreshMigration` / `counterpartyBoardHankoRefresh` markers and
  the `AccountBoardHankoRefresh` input are keyed by the certified
  `EntityProvider.boardEpochs` value instead of the activation log position
  `(activationJHeight, activationLogIndex)`, in TS (producers, consumers, worker DTO,
  scheduler validation, snapshot wire) and Rust (engine incoming apply/signing,
  entity-kernel scheduler commitment, process wire, runtime checkpoint/restore/codec).
- `verifyJPrefixCertificate` no longer rebuilds and discards a structuredClone'd,
  sorted copy of every verified attestation. The returned certificate keeps the same
  envelope fields, key order and `verified` map; every signature, quorum,
  highest-common and round check is unchanged.

## Gates on this exact tree

- TS L1 117/117 (938 expects); runtime and contract types green.
- `bun run rscore:test` 1145/1145 (41 executables); rotation fixture regenerates with no diff.
- `rscore:parity`: first segment 93/94. The one failure,
  `tests/rscore/account-balance-direct.test.ts:462` (pinned 3658/406ab882 vs TS
  3505/d7d49292), reproduces byte-identically on a pristine export of `c85598fe`;
  it predates this change. Later parity segments are fail-stopped and unrun.
- `lock-ahb` via `stand:run --timeout-ms 150000`: exit 0, 91 frames.
- `bun run check`: source 38/38, top 3/3.
- Original six wallet assertions, trace on, against the public origin with real
  RPC/relay/faucet and the locally built runtime, account worker and React assets
  routed in (not a deployment).

Before this key ships, a bounded read of the public checkpoint must confirm that no
old-shape `activationJHeight` hooks or markers are persisted.
