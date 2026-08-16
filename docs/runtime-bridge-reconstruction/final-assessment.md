# Final bridge assessment

## Decision

**Yes: xln contains most of the protocol machinery needed for a liquidity-backed
lock/release bridge. No: the repository, as statically reconstructed, is not yet
safe to deploy unchanged as a production bridge.**

The recommended product is not a canonical burn/mint bridge. It is a two-runtime,
fully collateralized liquidity bridge in which user sibling Entities occupy one
Runtime, hub sibling Entities and the book occupy another, and jurisdiction
Depositories custody the actual assets.

## What should be reused

| Layer | Reusable xln component |
|---|---|
| Custody | Per-jurisdiction Depository reserves, collateral, withdrawal, debt settlement |
| Authorization | Entity boards, Hankos, domain-separated batch/account proofs, nonces |
| Conditional settlement | HTLC payments and full/partial hash-ladder pulls |
| Cross-chain orchestration | Target-first setup, two legs, exact rational fills, source-first clear, salvage |
| Liquidity | Hub-side order book and fully collateralized risk mode |
| Networking | Signed discovery, direct/relay encrypted delivery, two-runtime topology |
| Durability | Persist-before-send outbox, route hydration, split-DB repair, snapshots |
| Offline safety | Dispute proofs, wake watcher, encrypted backup, delayed counter-dispute tower |

## What should not be claimed yet

- trustless source-chain verification on the destination chain;
- canonical burn/mint or wrapped-asset issuance;
- permissionless third-party solvers across arbitrary runtimes;
- production-safe receipt and inter-runtime authorization;
- production finality/reorg safety for every jurisdiction;
- audited custody and cryptography;
- deployed validator/watchtower independence or tested recovery SLOs.

## Production blockers

### P0 — protocol authorization

1. Replace the self-hashed target admission receipt with a proof bound to the
   committed target Account frame/state, target pull, route hash, and target-user
   authority.
2. Add one canonical inbound cross-j authorization gate. It must verify the
   authenticated source Runtime against the resolved route topology before any
   target Entity transaction is queued.
3. Decide which cross-j instructions require a source-Entity Hanko and define a
   domain-separated envelope with route ID, message kind, sequence, target,
   expiry, and payload hash.
4. Bind runtime encryption key and handshake context into hello authentication;
   add replay-resistant challenge/nonce handling.

### P0 — custody and durability safety

1. Introduce a financial Runtime profile that refuses to start or emit side
   effects unless storage is enabled, writable, and canonical hashing is active.
2. Protect `entityEncPrivKey`, Account watch seeds, and dispute material at rest.
3. Make backup-barrier policy explicit for fund-moving deployments.
4. Make expected Depository-topic decoding fail closed instead of silently
   advancing the watcher cursor.

### P0 — finality and emergency behavior

1. Define confirmation/finality policy separately for every supported chain.
2. Require independent RPC/watcher observations across validator failure domains.
3. Specify halt, reconciliation, and operator authority for a post-finality reorg.
4. Bind deployed contracts, transformer allowlist, assets, and admin roles to a
   versioned release manifest.

## Recommended delivery sequence

### Phase 1 — freeze the bridge profile

- Limit v1 to the existing two-runtime topology and `fully_collateralized` mode.
- Select two jurisdictions and a small reviewed asset set.
- Document liquidity provider, fee, timeout, finality, and maximum exposure rules.
- Treat generic solver/multi-runtime work as out of scope.

### Phase 2 — close authorization gaps

- Implement authenticated target-lock receipt proof.
- Implement inbound topology/source authorization.
- Implement signed cross-j envelopes where Runtime identity is insufficient.
- Harden hello key binding and replay resistance.

### Phase 3 — harden custody and recovery

- Require storage and canonical commitments.
- Add protected local secret storage.
- Require encrypted backup freshness before configured high-risk side effects.
- Define deterministic restart/resend behavior for every cross-j FSM phase.

### Phase 4 — establish chain safety

- Fail closed on watcher decode errors.
- Configure per-chain finality and RPC diversity.
- Establish deep-reorg and chain-halt procedures.
- Lock transformer/deployment/asset manifests.

### Phase 5 — evidence ladder

When executable work is authorized, collect evidence in this order:

1. narrow invariant tests for each P0 control;
2. targeted two-Runtime/two-jurisdiction flows;
3. crash and retry at every setup/fill/clear/salvage boundary;
4. adversarial receipt, ingress, replay, watcher, and reorg simulations;
5. contract and protocol audit;
6. capped-value deployment with monitored tower/validator SLOs;
7. gradual exposure increase governed by explicit risk limits.

## Innovation assessment

Garden and deBridge already demonstrate intents, solver liquidity, and
cross-chain execution as a product category. xln's room for innovation is not
“another hashlock bridge.” Its differentiated design surface is the combination
of:

- bilateral state channels with enforceable total-delta settlement;
- cumulative partial hash-ladder claims;
- Entity-board Hankos spanning off-chain and jurisdiction authorization;
- target-first, Account-committed cross-j fills;
- a two-runtime hub model with durable outbox and dispute salvage;
- encrypted recovery plus narrowly authorized delayed watchtowers.

That combination could support capital-efficient, partial-fill, recoverable
cross-jurisdiction liquidity settlement. The innovation becomes credible only
after the authorization and operational controls above are closed.

## Bottom line

Use xln as the bridge's settlement and liquidity substrate. Do not extract only
the hashlock code, and do not market the present system as trustless or
production-ready. Preserve the integrated Account + Entity + Runtime +
Depository model, harden its trust boundaries, then prove it under adversarial
multi-process and multi-chain conditions.

