![XLN Network Visualization](frontend/static/img/preview.png)

xln is unified layer2 for EVM jurisdictions. Works as a reserve-credit network of accounts. Our accounts a hybrid of full-credit banking accounts and full-reserve "payment channel" style accounts (as in Lightning/Raiden/Hydra). This superset allows great synergy and solves inbound capacity and Diamond-Dybvig problem with hub runs in TradFi.

/src is core implementation of server->entity->account state machine hierarchy. 

/frontend is ui in svelte that imports auto-rebuilt server.js and uses server logic inside the browser

/docs various concepts of the network

/contracts on-jurisdiction smart contracts: Depository, EntityProvider, SubcontractProvider
 
## At a glance (J/E/A machines)

- **J-machine**: Public registry of entities, reserves, and dispute outcomes. Optional anchoring layer for registered entities across chains.
- **E-machine**: Governance and policy for an organization. Quorum signs proposals to commit actions and anchor account roots.
- **A-machine**: Channels and subcontracts for users and apps. Emits proofs that E-machines sign and commit.
  
## Key Concepts

1. **JEA**: Jurisdiction → Entity → Account hierarchy. Think of it as Registry → Organization → Operations.
2. **State machines**: Each participant maintains their own cryptographically-secured ledger. No single point of failure.
3. **Personal consensus**: Your organization advances when YOUR quorum signs. No waiting for global agreement.
4. **Hanko signatures**: One signature proves entire approval hierarchies. Board→CEO→CFO→Treasury in one proof.
5. **Universal integration**: Single Hanko authorization works across Uniswap, Aave, Compound, and any protocol.

We refer to these as J/E/A machines: a Jurisdiction machine (J-machine), an Entity machine (E-machine), and an Account machine (A-machine).

## Machines in XLN (J/E/A)

- **J-machine**: Public registry/observer of entities, reserves, and dispute outcomes; maintains a verifiable ledger of registrations and collateral events for anchoring registered E-machines.
- **E-machine**: Governance/policy machine for an organization. Proposals, votes, and finalized actions are committed block-by-block by the entity’s quorum.
- **A-machine (account/channel)**: Channel and subcontract state for users; bilateral or nested machines that emit proofs which E-machines sign and commit.

These ledgers are sovereign and composable. Interactions are mediated by signatures, not by a global sequencer.
  
## Quick Start

### Run the server
```bash
bun run dev
```

Optional flags: set `NO_DEMO=1` to skip the demo.
 
## Why XLN vs L2/Rollups

- **No single global DA/consensus**: Per-machine ledgers remove sequencer risk and DA bottlenecks.
- **Zero-marginal-cost hierarchy**: Hanko enables infinite committees/sub-DAOs at 0 gas.
- **Institutional governance**: BCD separation maps to real corporate control/economics.
  
## Glossary

- **Precommit**: Validator signature over a proposed frame.
- **Frame**: Deterministic batch of actions to be committed as a block. Server, entities and accounts have separate chain of frames, stored hierarchically within each other.
- **Hanko**: Hierarchical signature scheme treating entities as signature programs.
 