# xlnc: programmable jurisdiction and multi-J launch

## Current owner scope — 2026-10-10

The owner selects Ethereum, TRON and **XLNC** as the three launch jurisdictions.
A jurisdiction is the blockchain execution field; a stack is a concrete
Depository, EntityProvider and its linked contracts inside that field. Each
independently governed launch stack has its own EntityProvider Foundation #1
and onchain shares. Companies are ordinary multisig numbered Entities in the
existing EntityProvider, with its existing onchain CONTROL/DIVIDEND shares;
do not introduce a separate company factory, wrapper token or index product.

XLNC must have **four nodes** and a **10-fold lower per-block gas limit than
Ethereum mainnet**. The owner explicitly replaced the earlier 100-fold request
with 10-fold after seeing the deployment and dispute gas measurements. The
four-validator topology uses the existing Besu/QBFT prototype; four processes
on one host are not four independent failure domains. Pin the reference
Ethereum block/hash and gas limit in the final network manifest. A 60,000,000
reference gives **6,000,000 gas per XLNC block**; this is a reference calculation,
not a claim to have sampled a current Ethereum block. Block period and gas
price are separate parameters.

Use normal EVM deployment transactions at the selected limit. Genesis contract
predeployment, temporary higher limits and splitting disputes across transactions
are not the chosen implementation. Measure complete deployment receipts rather
than substituting bytecode-deposit lower bounds for actual gas use.

The earlier 600,000 budget could not fit the current contracts: runtime code
storage alone costs 3,802,600 gas for EntityProvider, 4,437,000 for Depository
and 4,548,400 for Account, before constructor execution and intrinsic gas.
These lower bounds do not block deployment at the new 6,000,000 limit.

The existing `BatchBoundsTest.test_gas_disputeFinalizeWithMaxProofTokens` measured
733,682 execution gas to start and 2,074,972 to finalize a valid 128-token proof,
plus transaction intrinsic gas. This particular shape no longer demonstrates
an impossible fit at 6,000,000. It does not close the more expensive mixed-proof
and correlated-exit gates recorded below. Keep those gates; do not silently
reduce accepted financial proof bounds or change EVM gas pricing.

The focused `test/governance/company/MultisigCompany.test.ts` contract scenario
proves 2-of-3 registration and onchain share allocation using the existing EP:
registration 246,829 gas, allocation 198,068 gas. It checks treasury issuance,
insufficient signatures, recipient substitution, replay rejection and exact
balances/nonces. This local contract scenario is not a browser journey or proof
that every possible company board fits XLNC.

The previous producer/verifier prototype and measurements below are historical
evidence, not compliance with the new four-validator launch target.

### Four-validator local evidence — 2026-10-10

The updated `xlnc:prototype` passed on Besu 25.9.0 with four separate validator
keys, four full-state processes, a static peer mesh, one-second QBFT blocks and
a 6,000,000 block gas limit throughout. Eight contracts deployed by ordinary
transactions; the ninth transaction bound the share Depository. The largest
receipt used 4,971,259 gas (Account); Depository used 4,905,451 gas. Every deployed
contract's code matched across all four nodes, as did the block hash/state root.
With validator 4 stopped, the remaining three committed a signed transaction;
validator 4 then restarted on its existing database, caught up and matched roots.
All processes were stopped at the end. No public deployment or real funds.

The first run reached deployment/root equality and chain progress during an
outage but exceeded the 60-second stand limit during restart. The correction
starts nodes concurrently with a full static mesh and sets `--sync-min-peers=1`:
Besu's default of five sync peers cannot be met by a four-node network. This
setting changes peer discovery/sync startup, not the QBFT signing quorum.

[Receipts and roots](evidence/xlnc-20261010/four-validators.json) and
[successful stand log](evidence/xlnc-20261010/four-validators.log) preserve the
local evidence. These same-host nodes do not prove independent-operator fault
tolerance. A separate, existing mixed-proof regression remains red:
`test_gas_mixedDefensiveFinalizeWithMaxAccountDimensions` uses 17,388,717
execution gas to finalize, before intrinsic gas, exceeding both 6M and its 15M
assertion. [Failure evidence](evidence/xlnc-20261010/mixed-exit-gas.log).
The owner-selected 6M limit is unchanged; full financial launch readiness is
not claimed and no proof bounds or dispute semantics were weakened.

Date: 2026-09-05. Investigated SHA: `b97c454d605e750a08da7ff6baab645330175468`.
Status: proposal, no change to consensus, network configuration, or capital limits.
Owner scope clarified 2026-09-30: Ethereum, TRON and XLNC are the initial focus;
Base, Arbitrum and additional compatible EVM Js share the same financial model.
H1–H3 and MM are ours first. The earlier $1 000 proposal below is historical;
the later [launch design](launch-design.md) governs the capital ladder.
Name: **"limited mainnet / soft mainnet."**
This is a designation of risk scale, not proof of readiness or security.

## Decision

A **block producer** is the J node proposing blocks; consensus validators
check/vote on those blocks according to the chosen consensus. A verifier checks
the accepted history without participating in block production. These roles
are separate from Entity hubs, Account parties and their bilateral consensus.
The one-producer/separate-verifier artifact below is an experimental starting
point, not a decision about the production validator set or consensus engine.

- XLNC must fulfill the role of J: Entity registration/authority, reserves, collateral, settlement, disputes, and the needed evidence.
- Payments, routing, credit, and swaps remain in R/E/A. Do not record every payment on the global chain.
- Full local verification of XLNC is a useful goal. It does not mean full local verification of Ethereum, TRON, and Base.
- Reuse a mature consensus mechanism and contract execution; do not create new consensus mechanics now.
- Start with ordinary EVM execution and a smaller block gas budget. A custom XLN-only admission rule is not part of the selected direction.

## Conventional EVM direction — owner update 2026-09-30

XLNC is pronounced **“excellence”**. Its purpose is a compact programmable J
for reserves, rights and adjudication, with routine economic activity in accounts.
The owner selected conventional stateful EVM execution with roughly 10–20 times
less block gas capacity. Ordinary activity uses accounts; J serves rebalances
and disputes. Expensive ordinary J execution can reinforce this separation.

The proposed design has five requirements:

1. Pin an EVM revision and reuse a proven consensus core. An EVM interpreter
   supplies execution, not agreement on ordering or finality.
2. Set a substantially smaller block gas budget and measure ordinary execution,
   storage and network cost. Lower gas capacity bounds offered J execution;
   gas price is a separate steering mechanism. Keep the exact reference network,
   block interval and selected gas limit in the network manifest.
3. Run an ordinary stateful full node: store J state, verify blocks and use the
   selected client's normal synchronization. Measure phone/laptop continuous
   operation and catch-up of the last couple of days within five minutes.
   Account frames remain retained by their parties without per-payment J publication.
4. Reserve affordable gas and inclusion capacity for dispute start, counter,
   evidence publication and finalization under correlated hub failure. Price
   discretionary J traffic heavily without pricing users out of secured recovery.
5. Publish pinned genesis/domain, contract hashes, rule/upgrade policy and an
   explicit ordinary-client bootstrap path. Publish measured CPU, memory,
   disk, bandwidth and synchronization results for the intended devices.

No ZK execution, stateless client or execution-witness protocol is required.
The earlier witness proposal was an auditor suggestion rejected by the owner;
it is not the XLNC architecture.

The emergency sizing condition is concrete: remedies due within a protection
window must fit its reserved J execution and byte capacity. Account throughput
and low average J load do not prove this correlated-exit bound. Measure it at
the actual reduced block gas limit before admitting obligations.

This specification remains proposed. The first production artifact is the
producer/verifier round trip below; unrelated core recovery work retains priority.

## Measured prototype — 2026-09-30

The ordinary stateful Besu 25.9.0 prototype now runs through
`bun run xlnc:prototype <output-directory>` with `XLNC_BESU_BIN` and
`JAVA_HOME` set. It uses Cancun EVM, a 6M block gas limit and one-second
QBFT blocks. This is 10× below the existing local 60M _per-block_ ceiling;
its different block period prevents claiming 10× lower execution per second.

One producer and one full verifier on the same laptop matched the block hash,
state root and all four contract code hashes. Restart preserved the producer
root. Non-dev deployment created no development tokens; a zero EIP-1559
priority fee succeeded. This establishes a working local J prototype, not
production consensus, phone resources, two-day catch-up or correlated exits.
The complete first run produced `/tmp/xlnc-stateful-paid-gas-evidence/evidence.json`.
Later repeats matched contracts and roots but hit the 60-second stand limit
during node restart; the latest repeat is not green. Owned node process groups
are now terminated on interruption; both repeats with this cleanup left no
running node groups.

Exit capacity is an open release blocker. The cold maximum-token zero-delta
vector used 2,046,965 execution gas. A signed mixed proof with 128 tokens,
32 payments, 32 swaps and 18 unrevealed pulls finalized but used **17,363,517**
execution gas plus transaction intrinsic gas. Its regression deliberately fails
the existing 15M envelope; it also cannot fit 6M. This is one valid expensive
shape, not a universal upper bound. Current Account bounds must not be claimed
compatible with the reduced ceiling. Changing admission or J capacity requires
an owner decision; no contract limits were silently changed.

The `htlc-ack-recovery` real-RPC scenario separately proves that a late
preimage, withheld upstream ACK and WAL reopen reach an authenticated J dispute.
It uses three real Entity/Account machines and preserves the transport partition.
This verifies dispute start and retained evidence, not collateral payout or
TS/Rust equivalence of this complete recording.

The earlier `0b25d54ca` checkpoint failed the English-source gate. At
`1d39fe8e6`, `bun run check` passed, frozen core was unchanged, and the canonical
Chromium catalog recorded 138/138 targets with zero skips through catalog runs
and focused reruns. The final rebuilt ScenarioPlayer regression also passed.
See [the implementation handoff](jea-continuation.md) and its committed evidence.
The earlier manual localhost `/app` `effect_orphan` observation remains a separate,
untriaged development observation; it was not reported by those isolated builds.
These results do not close the XLNC exit-capacity or device-resource gates.

## What already exists

| Boundary     | Observation in code                                                                                             | Consequence                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| J → Entity   | [Canonical architecture](core/rjea-architecture.md), [J machine](runtime/jurisdiction.md)                       | External RPC does not become the reducer's authority; observations go through canonical validation      |
| Adapter      | [JAdapter](../core/jurisdiction/adapter/types.ts): `rpc`, `tron`, `anvil`, `browservm`                          | XLNC does not require a new Account/Entity financial path                                               |
| Finality     | [rpc-finality.ts](../core/jurisdiction/adapter/rpc/rpc-finality.ts): Ethereum 12 blocks, other EVM 2 by default | These numbers do not prove consensus finality; Base/XLNC must not be connected with an implicit default |
| Dev networks | [chain-ids.ts](../core/jurisdiction/adapter/chain-ids.ts): 31337/31338 enable dev behavior                      | XLNC gets its own chain ID, genesis hash, and release manifest; it is not a renamed Anvil               |
| Capital      | [Current policy](../ops/capped-testnet-policy.json): `riskCapUsd: null`, enforcement absent                     | $1 000 is currently an owner decision, not a programmatically enforced limit                            |

The verified production files contain no runnable XLNC validator/fullnode. The old `Xlnomy` types with EVM-engine names do not prove a network implementation.

## Minimal path: ordinary EVM with less global execution

Use an existing EVM client and consensus engine, the canonical xln contracts,
and a smaller block gas limit. This is the selected architectural direction,
not merely a temporary rig. No XLN-only opcode, transaction allowlist, native
financial interpreter or special execution-witness protocol is required.

Set the absolute gas limit and block interval in genesis/network rules. Measure
execution, state growth and catch-up with the ordinary client. Account activity
avoids per-payment J execution; pricing discourages discretionary J transfers.
The exact client and production consensus remain choices to resolve against
device measurements and independent-operator requirements.

Besu/QBFT is a concrete candidate for the rig: existing PoA and validator-set management. For Byzantine fault tolerance, Besu requires a minimum of four validators. This is not yet the choice of the XLNC engine. [QBFT](https://docs.besu-eth.org/private-networks/how-to/configure/consensus/qbft)
For a mass desktop bundle, Besu has a significant downside: the private-networks documentation states a minimum JVM of about 4 GB depending on the environment. Measure the real budget before choosing; a small J-load does not prove a small client. [Besu requirements](https://docs.besu-eth.org/private-networks/get-started/system-requirements)

## Full node at the user

```text
UI → local xln Runtime → JAdapter → local XLNC verifier → XLNC peers
                                      ↑
                   separate node process; no validator/private-wallet keys
```

- The desktop installer offers and enables the verifier by default, with explicit disk/memory disclosure. The user can stop it; the UI shows the loss of local-verification mode.
- The validator is a separate role with a separate key. A thousand fullnodes do not turn one validator into a thousand independent producers.
- Use the client's ordinary full-node synchronization and persist its verified state. Reopening after two days means catching up those two days, not replaying genesis. Fullnode and archive are different responsibilities. [Nodes and clients](https://ethereum.org/developers/docs/nodes-and-clients/)
- Specify the initial synchronization mode and any bootstrap trust separately from later incremental catch-up. A supplied snapshot must have the client's required verification; disclose any additional trusted checkpoint. This does not require a stateless execution design.
- A browser page does not install a desktop daemon by itself. BrowserVM is not a network XLNC fullnode; a browser-only client needs a separately proven verifier/connection to a local companion. Browser storage has quotas and persistence modes. [Storage Standard](https://storage.spec.whatwg.org/)

Show separately: `local verification`, `verified up to block`, `bootstrap source`, `lag`, `independent operators`.
If the node has fallen behind, do not silently switch financial authority to a remote RPC. Recovery/synchronization are available; new operations wait for the needed J readiness.

## What localhost protects

| Threat                                        | Effect of local full verification                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| RPC returns an incorrect balance/log/state    | The node rejects invalid history given a correct client and a trusted genesis                            |
| A single validator censors settlement/dispute | Does not solve this: a valid block may simply not contain our transaction                                |
| A validator signs two valid histories         | Can be detected upon receiving both; a single local verification cannot pick a common order for everyone |
| The node is isolated from honest peers        | Rules are checked, but the currency/availability of the history is not guaranteed                        |
| Malicious update, compromised host, or key    | Does not solve this; bundled monoculture increases the overall blast radius                              |

Design minimum: loopback-only bind; OS IPC with user permissions where supported; otherwise an authenticated loopback endpoint.
Check Host/Origin and WebSocket Origin, close wildcard CORS, restrict methods and request size/rate; separate out wallet signing and the validator/admin API.
A local port is accessible to other local processes. CORS does not replace authentication. Do not keep an unlocked signing account on an accessible RPC. [Geth RPC](https://geth.ethereum.org/docs/interacting-with-geth/rpc), [Besu RPC authentication](https://docs.besu-eth.org/public-networks/how-to/use-besu-api/authenticate)
Regression goal: a foreign Origin/Host, an unauthorized WS, and an admin method are rejected; the standard UI reads the chain and only submits an already-signed transaction.

## Availability, updates, and decentralization

- A single validator is acceptable as a disclosed centralized experiment: stopping it halts J, including withdrawals/disputes. Key backup and recovery do not provide Byzantine safety; two copies of the signing identity must not be run simultaneously.
- At the start, keep several replicas of full blocks on different machines and verify recovery from them. Different machines of one firm provide availability, not independent governance.
- Next stage: independent operators and a chosen quorum, a shared genesis/rules, and a proven validator-set change and single-party failure. For QBFT, an example is 4 independent validators with tolerance 1; 4 of our own processes do not provide independence. [QBFT](https://docs.besu-eth.org/private-networks/how-to/configure/consensus/qbft)
- Signed releases with fixed hashes, reproducible builds, staged rollout, and local manifest verification reduce supply-chain risk. An independent compatible verifier will later reduce the monoculture; a second consensus implementation is not P0 right now.
- Historical blocks must be available to a new node without a single server. Optional publication of the block hash on an external network proves the existence of a commitment, but by itself does not provide data, forced inclusion, exit, or rollup security.

XLNC stores J-operations and the necessary evidence; private Account frames and every off-chain hop are not published there.
Limit validation cost, block bytes/gas, and state growth. Cheap gas requires protection against disk filling; "free for everyone without limits" is incompatible with a node at every user.
Emergency exit requires an available J and inclusion. Do not promise that a local copy automatically withdraws funds when the single validator has stopped.

## Additional EVM jurisdictions and limited exposure

| Network           | Before admitting capital                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Ethereum          | Verified bytecode/address/domain, live J, withdrawal/dispute, explicit finality policy                |
| TRON              | Real TVM/write/receipt/resource paths and solidified head; Anvil is not evidence                      |
| Base              | Contract artifacts and separate unsafe/safe/finalized observations; two L2 blocks are not L1-finality |
| Arbitrum          | Verified deployment and chosen chain's DA/finality rules; real dispute and withdrawal behavior        |
| XLNC experimental | Genesis/rules/validator manifest, full-node verification, real assets and their issuer/backing        |

Base ties the finalized L2 head to L1-finality. Financial admission requires consciously choosing a risk level, not a "ready in N seconds" timer. [Base derivation](https://docs.base.org/base-chain/specs/protocol/consensus/derivation)
Additional networks add corridor pairs and directions; Ethereum/Base and our H1–H3/MM are not independent sources of risk. Base and Arbitrum require their own verified observation, finality, dispute and withdrawal boundaries rather than a presumed generic EVM default.
The first exercise is one minimal real round trip on each new boundary with a withdrawal; the full cross-J matrix remains the final gate.
Account for liquidity, gas/resource balances, dispute reserve and deployment fees within the admitted capital stage from [launch-design.md](launch-design.md); the asset limit is separate from the operating-expense limit.
Allocate capital using measured deployment costs, required reserves and useful liquidity across the admitted Js. Additional jurisdiction support does not automatically raise capital authorization.
An XLNC token named USDT does not become Tether USDT. An explicit issuer/redemption/collateral is needed; a bridge and a wrapped asset are additional risk, not a free integration.
Limits must be applied before admitting an obligation, including quotes/lease/credit and crash recovery; a single UI limit is not sufficient. Capital growth only after a measured round trip, reconciliation, and a separate owner decision.

## Next decisions and evidence

1. Select the existing client/consensus, absolute block gas limit and block interval; compare the stated 10–20× reduction against an explicit baseline.
2. Disclose the experimental single-producer trust model and recovery on stoppage; if independent exit is unavailable, label that limitation explicitly.
3. First XLNC artifact: genesis → 1 producer + 1 verifier → canonical deployment → reserve → Account collateral → payment → settlement → withdrawal → restart → identical roots/logs.
4. Before money: producer failure, a corrupted block, incompatible rules, an invalid snapshot, missing data, and an unavailable RPC produce an explainable halt. No automatic genesis reset.
5. Then verify each admitted J boundary, run the full check, and admit the authorized capital stage; XLNC R&D does not delay resolving the current production recovery divergence.

[MML](intro.md#mission) is accounts supporting 51% of world GDP made provable
by 2050, including activity not individually submitted to J. Payment turnover is
separate from GDP coverage. Measure unique completed operations for adoption
evidence: one payment once, one exchange without summing both legs, excluding
circular relays and tests. The method for attributing GDP coverage remains open.
The nearest useful numbers: successful withdrawals, losses/discrepancies, cost of a completed operation, capital tied up, recovery time, and the share of clients that actually verify locally.
