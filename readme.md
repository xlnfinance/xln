# XLN: Where Traditional Finance Meets DeFi

**TradFi + DeFi = XLN** — The superset of both worlds, delivering institutional-grade governance with crypto-native innovation.

XLN is not a rollup or another L2. It is the **organizational layer** for digital finance: each Entity is a state-time machine with its own blocks, quorum, and storage. There is **no single global ledger**; instead, every Jurisdiction/Entity/Account maintains its own append-only ledger and interops via signed messages.

**For Crypto**: Zero-cost DAO creation, infinite organizational complexity, cross-chain identity  
**For Institutions**: Cryptographic audit trails, hierarchical approvals, dual-class governance  
**For Everyone**: The missing infrastructure for programmable organizations

## At a glance (J/E/A machines)

- **J-machine**: Public registry of entities, reserves, and dispute outcomes. Optional anchoring layer for registered entities across chains.
- **E-machine**: Governance and policy for an organization. Quorum signs proposals to commit actions and anchor account roots.
- **A-machine**: Channels and subcontracts for users and apps. Emits proofs that E-machines sign and commit.

### Diagram: Layered architecture

```mermaid
graph TD
  subgraph J["J-machine (Jurisdiction)"]
    JR["Registry / Reserves / Disputes"]
  end

  subgraph E["E-machine (Entity)"]
    EG["Governance & Policy"]
    AR["Committed A-root"]
    EG --> AR
  end

  subgraph A["A-machine (Account)"]
    CH["Channels & Subcontracts"]
  end

  CH -->|proofs| EG
  EG -->|registration / numbering| JR
```

## Why XLN: The Best of Both Worlds

### From Traditional Finance
- ✅ **Hierarchical governance** like real corporations
- ✅ **Dual-class shares** (Meta/Alphabet style)
- ✅ **Audit trails** for every decision
- ✅ **Subsidiary management** with proper controls
- ✅ **Compliance-ready** architecture

### From DeFi
- ✅ **Zero-cost entity creation** (spawn 1000 DAOs free)
- ✅ **Composable governance** modules
- ✅ **Cross-chain operations** native
- ✅ **Permissionless innovation** 
- ✅ **Cryptographic guarantees** throughout

### Beyond Both
- 🚀 **State machines** > Smart contracts
- 🚀 **Bilateral sovereignty** > Global consensus
- 🚀 **Organizational primitives** as first-class citizens
- 🚀 **Infinite complexity** at zero marginal cost

## Key Concepts

1. **JEA**: Jurisdiction → Entity → Account hierarchy. Think of it as Registry → Organization → Operations.
2. **State-time machines**: Each participant maintains their own cryptographically-secured ledger. No single point of failure.
3. **Personal consensus**: Your organization advances when YOUR quorum signs. No waiting for global agreement.
4. **Hanko signatures**: One signature proves entire approval hierarchies. Board→CEO→CFO→Treasury in one proof.
5. **Universal integration**: Single Hanko authorization works across Uniswap, Aave, Compound, and any protocol.

We refer to these as J/E/A machines: a Jurisdiction machine (J-machine), an Entity machine (E-machine), and an Account machine (A-machine).

## Machines in XLN (J/E/A)

- **J-machine**: Public registry/observer of entities, reserves, and dispute outcomes; maintains a verifiable ledger of registrations and collateral events for anchoring registered E-machines.
- **E-machine**: Governance/policy machine for an organization. Proposals, votes, and finalized actions are committed block-by-block by the entity’s quorum.
- **A-machine (account/channel)**: Channel and subcontract state for users; bilateral or nested machines that emit proofs which E-machines sign and commit.

These ledgers are sovereign and composable. Interactions are mediated by signatures, not by a global sequencer.

## Account Layer (generalized)

- **Channels (bilateral A-ledgers)**: Deterministic, bilateral machines replicated at both sides. Each channel has a stable `channelKey = sha256(min(addrL,addrR) || max(addrL,addrR))`. State includes `blockId`, `timestamp`, `transitionId`, `previousBlockHash`, `previousStateHash`.
- **Subchannels & deltas**: Each channel holds many subchannels with token-specific deltas and limits:
  - `leftCreditLimit/rightCreditLimit`, `leftAllowance/rightAllowance`, `collateral`, `ondelta/offdelta`, `cooperativeNonce`, `disputeNonce`.
  - `proposedEvents` are typed intents (e.g., settle, withdraw) that become proofs for the Entity to sign and commit.
- **Subcontracts**: Embedded contract-like records per token/chain, tracking deposits/withdrawals (`leftDeposit/rightDeposit`, `leftWithdraw/rightWithdraw`) and `status` (active/closing/closed).
- **Proof encoding**: Channel state is RLP-encoded and stored under `channelMap[channelKey]`; the channel root is committed in the Entity’s final block, anchoring the A-ledger into the E-ledger.
- **Counters and safety**: `pendingSignatures`, `sendCounter/receiveCounter`, `rollbacks`, and nonces coordinate cooperative vs dispute flows.
- **Determinism**: All channel/account state commits via RLP+Merkle with per-machine signatures, enabling replay, audit, and fast recovery.

### Diagram: Account/channel structure

```mermaid
graph LR
  A["A-machine"] --> CKey["channelKey = sha256(min(L,R)||max(L,R))"]
  CKey --> State["channel state: blockId, timestamp, transitionId, prev hashes"]
  State --> SubC["subchannels: token→(delta, limits, nonces)"]
  State --> SubK["subcontracts: deposits/withdrawals, status"]
  SubC --> Proofs["typed proposedEvents → proofs"]
  SubK --> Proofs
  Proofs --> ECommit["E-machine commit (A-root)"]
```

## Quick Start

### Run the server
```bash
bun run src/server.ts
```

Optional flags: set `NO_DEMO=1` to skip the demo.

### Explore docs
- `docs/README.md` — architecture from ground to sky
- `docs/memo-to-model.md` — tone, positioning, and summary guide
- `docs/hanko-architecture.md` — hierarchical signatures and integration
- `docs/contract-architecture.md` — smart contract split and decisions

## Why XLN vs L2/Rollups

- **No single global DA/consensus**: Per-machine ledgers remove sequencer risk and DA bottlenecks.
- **Zero-marginal-cost hierarchy**: Hanko enables infinite committees/sub-DAOs at 0 gas.
- **Institutional governance**: BCD separation maps to real corporate control/economics.

## Security & Invariants

- Deterministic, signed blocks per machine (replayable).
- Quorum thresholds enforced for progression.
- RLP+Merkle snapshots persisted to LevelDB; batch writes for safety.

### Diagram: Entity quorum flow

```mermaid
sequenceDiagram
  participant P as Proposer (replica)
  participant V as Validators (quorum)
  participant E as E-machine

  P->>V: propose(frame)
  V-->>P: precommit(sig)
  P->>E: commit(frame, sigs)
  E-->>V: new block (height+1)
```

## Visual Demo

Run the deterministic demo:

```bash
bun run src/server.ts
```

You should see output like:

```text
🎯 === FINAL VERIFICATION ===
🔍 Consensus: ✅ SUCCESS (messages: ✅, proposals: ✅)
📊 Entity #1: 10 messages, 0 proposals, height 3
📊 Entity #2: proposals pending (gossip mode)
📸 Snapshot captured: "Tick 59: ..."
```

On-chain registration will attempt via local RPCs; if none are running you’ll see connection errors, which is expected for offline runs.

## Glossary

- **Precommit**: Validator signature over a proposed frame.
- **Frame**: Deterministic batch of actions to be committed as a block.
- **A-root**: Merkle root of A-machine state recorded by an E-machine block.
- **Hanko**: Hierarchical signature scheme treating entities as signature programs.

## The XLN Advantage: Best of Both Worlds

**From Wall Street**: Hierarchies, controls, audit trails, compliance  
**From Web3**: Permissionless, composable, global, instant  
**Beyond Both**: Programmable organizations at zero marginal cost

We're not building another blockchain. We're building the organizational infrastructure that makes both traditional and decentralized finance obsolete by delivering everything each promises and more.

## Tagline options

- Where Wall Street meets Web3.
- TradFi + DeFi = XLN.
- The organizational layer for digital finance.
- Corporate governance, cryptographically guaranteed.
- Build organizations like you build software.
