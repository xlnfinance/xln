# xln module ownership map

Mission: make 51% of world GDP provable by 2050 (MML). J/E/A makes existing
financial relationships enforceable through programmable jurisdiction machines.
Measure useful unique economic value, with routed hops excluded from the total.

Read `readme.md` → [Introduction](intro.md) →
[J/E/A architecture](core/rjea-architecture.md). This map identifies owners and
boundaries; [minimum remaining work](launch-design.md#minimum-remaining-work--owner-alignment-2026-09-30)
sets implementation priorities. [FinTS](fints.md) and root `AGENTS.md` govern
correctness. A flow involving several folders needs one integrator, with one
implementer per transition; it does not create a second state machine.

## Protocol and durable boundaries

| Owner                                          | Receives                                                | Produces                                                   | First verification                                                         |
| ---------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `core/types/`, `core/protocol/`                | R/E/A/J commands and signed wire data                   | Canonical bytes, identity, hashes and state primitives     | Named TS/Rust/Solidity wire/hash vector                                    |
| `core/runtime/admit/`, `mempool/`              | API, P2P, J events and wakes                            | Ordered RuntimeInput; per-transaction typed rejects        | Reject one bad transaction while accepting its queue peers                 |
| `core/runtime/frame/`, `loop/`                 | RuntimeInput and committed Runtime state                | Runtime candidate, ordered outputs and WAL plan            | First divergent frame; inbound Account → Entity work → outbound Account    |
| `core/entity/consensus/`                       | EntityInput, board signatures and previous state        | Certified EntityFrame and ordered hash manifest            | Candidate isolation and exact replay                                       |
| `core/entity/tx/`                              | EntityTx, J facts and AccountInput                      | Entity state, local AccountTx admission and routed outputs | Production path for the changed transaction kind                           |
| `core/account/consensus/`                      | Bilateral proposals, ACKs and disputes                  | Committed AccountFrame or typed reject                     | Exact duplicate idempotence; LEFT collision; conflicting hash rejection    |
| `core/account/tx/`                             | Admitted AccountTx, AccountState and J claim            | AccountState/root and financial outputs                    | Compare both parties with deriveDelta; deadline/J-finality vector          |
| `core/jurisdiction/machine/`                   | Verified observations and signed batches                | Certified J facts and batch commitments                    | Watcher event → J-prefix → Entity/Account                                  |
| `core/jurisdiction/adapter/`                   | External blocks, logs, receipts and submit intent       | Authenticated observations and receipt/error               | Real target-network watcher and receipt; BrowserVM is development evidence |
| `core/runtime/j-submit/`                       | Post-WAL batch intent and adapter responses             | Submission lifecycle and RuntimeInput                      | Retry/restart without double submission or lost receipt                    |
| `core/storage/commit/`, `wal/`, `database/`    | Candidate, canonical input and ordered outbox           | Fsynced WAL/HEAD/outbox                                    | Commit precedes effects; exact persisted bytes and roots                   |
| `core/storage/recovery/`, `read/`              | Checkpoint and ordered WAL                              | Recovered state or first mismatch                          | Crash/replay roots and ordered effect/event/outbox digests                 |
| `core/runtime/delivery/`                       | Committed outputs and destinations                      | P2P/API/J envelopes and delivery status                    | Ordered publication; reconnect without loss or duplicate effect            |
| `core/hanko/`, `jurisdictions/contracts/`      | Certified state, signer authority, nonce and batch      | Enforceable proof, contract state and J events             | Signed old/new-state adversarial vector; synchronized bytecode/artifacts   |
| `core/rscore/`                                 | TS canonical input, checkpoint and worker configuration | Rust bridge results and parity evidence                    | Same immutable WAL; no independent financial formulas                      |
| `rscore/crates/engine/`                        | Account wire input and prior state                      | Account roots, frames and ordered outputs                  | Named AccountTx vector followed by exact mixed WAL                         |
| `rscore/crates/entity-kernel/`                 | EntityInput, Account results and J facts                | Entity root, outputs and certificates                      | Three financial stages and J-event → Account parity                        |
| `rscore/crates/runtime/`, `batch/`, `process/` | WAL/checkpoint, RuntimeInput and watcher facts          | Runtime roots, outbox and post-commit effects              | Exact W1/W4 replay, then live J watcher → receipt                          |

## Economic products and services

| Owner                                               | Receives                                                 | Produces                                                | First verification                                                        |
| --------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `core/entity/paybook/`                              | Payment intent, route, lock/secret/ACK and J height      | Forward/settle/fail/refund intents and delivery result  | Real payment → final receipt; timeout/restart/withheld ACK                |
| `core/orderbook/`                                   | Offers, cancels, eligibility and pair finality           | Price-time matching, book root and swap-resolve intents | Settled fill, ordered TS/Rust matching and rounding                       |
| `core/extensions/cross-j/`                          | Signed terms and finality of both jurisdictions          | Bound route, Account/J intents and terminal outcome     | Full/partial/disputed swap with both receipts and Hub balances            |
| `core/pathfinding/`                                 | Profiles, fees, capacity, asset and amount               | Executable route/quote or rejection reason              | Quote agrees with available capacity                                      |
| `core/orchestrator/market-maker/`                   | Accounts, catalog, RPC and quote policy                  | Connectivity and offers admitted by Runtime             | Executable depth and committed fills; quote count is insufficient         |
| `core/extensions/lending.ts`, Account handlers      | Credit/rebalance intent and collateral/capacity          | AccountTx, bilateral commitment and receipt             | Named funding/close/reload vector; committed exposure                     |
| `core/runtime/registration/`, `core/entity/auth/`   | Registration, board updates and certified registry facts | Authorized identity and board descriptors               | Board rotation and retired-signer rejection                               |
| `core/network/p2p/`, `relay/`                       | Outbox, authenticated envelopes and discovery            | Runtime input and transport status                      | Reconnect, zero transport loss and drained Account ACKs                   |
| `core/watchtower/`                                  | Encrypted backup, appointment, quota and dispute events  | Restore bytes, tower receipt and last-resort action     | Fresh restore, quota rejection preserving prior backup and dispute timing |
| `frontend/src/lib/stores/vault/`, `ui/src/runtime/` | Keys, local store, encrypted backup and checkpoint       | Session, commands and committed receipts                | Fresh-device restore → new payment; interrupted publication               |
| `brainvault/src/core/`                              | Credentials and pinned Argon2id/BLAKE3 recipe            | Deterministic root and wallet key/address projections   | Same root across engines/workers; fresh-process address                   |
| `core/api/public/`, `server/`, `runtime-adapter/`   | Typed commands and committed Runtime state               | Admission, HTTP/WS responses and read projections       | Command → final receipt; public reads use committed state                 |
| `core/orchestrator/`                                | Configuration, DB, signer, network and J endpoints       | Running Hubs/MM and readiness                           | Restart without manual edits; separate J/P2P readiness                    |
| `custody/`                                          | Signed withdrawals/admission and chain status            | Authorized withdrawal and durable operator journal      | Signature, nonce/replay and journal/chain reconciliation                  |

## Views and evidence

| Owner                                   | Receives                                       | Produces                                         | First verification                                                  |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `frontend/src/`                         | User action, session and API projections       | Commands and balance/payment/swap/recovery views | Browser and console checks through final receipts                   |
| `ui/src/`, `native/`                    | Native bridge, vault and Runtime adapter       | Native commands, views and recovery              | Physical-device pay/swap/restore; camera denial and accessibility   |
| `cli/`                                  | Arguments, profile and daemon API              | Commands and final receipts                      | Invalid input, restart and retry without duplicate payment          |
| `core/qa/`, `core/scenarios/`, `tests/` | Production artifact, invariant and exact input | First mismatch, named regression and evidence    | Earliest failing production boundary; completeness after replay     |
| `scripts/`, `core/scripts/`, `tools/`   | SHA, configuration and locked resources        | Build, run, replay and gate artifacts            | Reproducible command, useful failure evidence and cleanup           |
| `ai/`, `debates/`                       | User prompts and authorized read APIs          | Responses and artifacts                          | Explicit authority boundary; no independent consensus-writing right |

## Evidence and scope

Historical reference: `main` at `566c850b3`, 2026-09-25. The recorded mixed WAL
matched 134/134 frames across TS/Rust W1/W4/W8, including R/E/A roots and ordered
outputs. Live Rust W1/W4 recorded 650/650 payments each and J Move paths.
These are dated functional results; they do not establish current release readiness
or valid 20-second TPS. Artifacts: `.logs/hlt-evidence/2026-09-25T03-13-05-243Z/`
and `.logs/hlt-live-rust-130-w{1,4}/`.

The September 25 report also recorded 11/12 selected browser tests and a cross-J
price/hold divergence. Later changes require fresh exact checks; neither an old
failure nor an old green result describes today's candidate automatically.
Current release blockers belong in root `todo.md`; dated evidence stays dated.

## Root cleanup and possible simplification

- Keep build/toolchain configuration, package manifest/lockfile, license/version
  and `AGENTS.md`: they have live consumers. `CLAUDE.md` points to agent workflow;
  root `todo.md` remains the single live checklist.
- `hlt-runs.json` and `foundation-release-board.json` are operational data with
  active readers/writers. Relocate them only with those consumers.
- `.DS_Store`, temporary logs, build output and test DBs need deliberate cleanup.
  Preserve recovery data and immutable failure evidence until their purpose ends.
- Historical `docs/releases/` snapshots retain linked evidence. Future large
  source snapshots can be separate artifacts; file size alone does not justify deletion.

Candidate deduplications from the dated review need caller and regression evidence
before implementation: delivery route-key merge (`pending.ts`/`plan.ts`), Move
workspace props, release-runner child waits, AHB credit fixtures, registry retries
and storage layout validators. They are proposals, not proven current defects.
Split large UI/API/QA files by concrete action and consumer only when necessary;
never introduce another financial reducer or durable authority to reduce line count.

Completion handoff: SHA, last green command, first red/error, artifact path, next
single command and remaining gates. Use the stand lock for heavy E2E/replay/TPS;
fix the first divergence before expanding coverage, then run `bun run check`.
