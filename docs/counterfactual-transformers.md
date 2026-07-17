# counterfactual transformers (custom clauses)

Status: SPEC — approved direction 2026-07-14 (wallet-authored Solidity clauses, no new DSL).

Two entities author an arbitrary Solidity clause inside their bilateral account via the
wallet. The clause is signed into account state as an `AccountSubcontract` and enforced
by the existing Depository dispute path. The contract is **counterfactual**: it deploys
on-chain (CREATE2, deterministic address) only if a dispute actually finalizes. The
cooperative path never touches the chain.

---

## 1. Trust model

- A clause is just another `IDeltaTransformer`: `applyBatch(deltas, params, leftArgs, rightArgs) view returns (int[])`.
- Depository already iterates arbitrary `ProofBody.transformers[]` addresses and clamps
  every delta diff with signed `allowances` (Depository.sol `_applyTransformer` +
  allowance loop). **Worst-case loss = the allowances both parties signed.**
- Execution is STATICCALL (the dispute helper is `view`): storage writes, CREATE,
  SELFDESTRUCT, value transfers are impossible at the EVM level. No new sandbox needed.
- Determinism between clients = Etherscan verification pattern: signed artifact is
  `keccak256(initcode)`; source + pinned solc version/settings travel alongside;
  counterparty recompiles and compares hashes. Pin solc **0.8.24** (repo pragma).

## 2. On-chain layer

### 2.1 What already exists (no changes)

- `ProofBody.transformers[] = { transformerAddress, encodedBatch, allowances }` (Types.sol)
- Depository applies each clause via staticcall, enforces per-delta allowance clamps,
  rejects moves on deltas without allowance.
- `DeltaTransformer.hashToTimestamp` — public secret-reveal registry, reusable by clauses.

### 2.2 ClauseBase.sol (new, non-consensus — just a base contract)

Rules for clauses:
- **Stateless, constructor-less.** All instance data lives in `params`
  (= `TransformerClause.encodedBatch`). Same code ⇒ same initcode ⇒ same CREATE2
  address ⇒ popular templates deploy once per jurisdiction, ever.
- Introspection functions are consumed by wallets (via BrowserVM), never by Depository.

```solidity
// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

interface ISecretRegistry {
  function hashToTimestamp(bytes32 hash) external view returns (uint256);
}

abstract contract ClauseBase {
  uint16 public constant MAX_FILL = 65535;

  // ── wallet introspection ──
  function paramsSchema() external pure virtual returns (string memory);   // "uint256 strike,uint64 expiry,..."
  function leftArgsSchema() external pure virtual returns (string memory); // "" if side supplies nothing
  function rightArgsSchema() external pure virtual returns (string memory);
  function describe(bytes calldata params) external view virtual returns (string memory);

  // ── Depository entry points (same convention as stock DeltaTransformer) ──
  function supportsArgumentTimestamps() external pure returns (bool) { return true; }

  function applyBatch(
    int[] memory deltas, bytes calldata params,
    bytes calldata leftArgs, bytes calldata rightArgs
  ) external view returns (int[] memory) {
    return transform(deltas, params, leftArgs, rightArgs, block.timestamp, block.timestamp);
  }

  function applyBatchWithArgumentTimestamps(
    int[] memory deltas, bytes calldata params,
    bytes calldata leftArgs, bytes calldata rightArgs,
    uint256 leftTs, uint256 rightTs
  ) external view returns (int[] memory) {
    return transform(deltas, params, leftArgs, rightArgs, leftTs, rightTs);
  }

  /// Clause logic. Return the transformed `deltas`.
  /// Evidence freshness: use leftTs/rightTs (starter evidence frozen at disputeStart,
  /// finalizer evidence fresh at finalize) — never block.timestamp for deadlines.
  function transform(
    int[] memory deltas, bytes calldata params,
    bytes calldata leftArgs, bytes calldata rightArgs,
    uint256 leftTs, uint256 rightTs
  ) internal view virtual returns (int[] memory);

  // ── helpers ──
  function secretRevealedBefore(address registry, bytes32 hash, uint256 deadline)
    internal view returns (bool)
  {
    uint256 t = ISecretRegistry(registry).hashToTimestamp(hash);
    return t != 0 && t <= deadline;
  }

  function fillOf(uint256 amount, uint16 fill) internal pure returns (uint256) {
    return amount * fill / MAX_FILL;
  }
}
```

### 2.3 Worked example — CallOption.sol

```solidity
pragma solidity ^0.8.24;
import "./ClauseBase.sol";

/// Holder may buy `baseAmount` of tokenIds[baseIdx] for `strikeTotal` of
/// tokenIds[quoteIdx] until `expiry`, fully or partially, by revealing a secret.
contract CallOption is ClauseBase {
  struct Params {
    bool    writerIsLeft;   // option writer side (delivers base, receives strike)
    uint8   baseIdx;        // index into ProofBody.tokenIds
    uint8   quoteIdx;
    uint256 baseAmount;     // e.g. 1e18 (WETH)
    uint256 strikeTotal;    // e.g. 3000e6 (USDC) for full baseAmount
    uint64  expiry;         // unix seconds
    address secretRegistry; // jurisdiction's DeltaTransformer (reveal registry)
    bytes32 exerciseHash;   // holder reveals preimage to exercise
  }

  function paramsSchema() external pure override returns (string memory) {
    return "bool writerIsLeft,uint8 baseIdx,uint8 quoteIdx,uint256 baseAmount,uint256 strikeTotal,uint64 expiry,address secretRegistry,bytes32 exerciseHash";
  }
  function leftArgsSchema() external pure override returns (string memory) { return ""; }
  function rightArgsSchema() external pure override returns (string memory) {
    return "uint16 fillRatio:portion to exercise (65535 = 100%);bytes32 secret:preimage of exerciseHash, 0x0 if already revealed on-chain";
  }
  function describe(bytes calldata p) external pure override returns (string memory) {
    Params memory prm = abi.decode(p, (Params));
    // wallet renders a human sentence from these fields
    return string(abi.encodePacked("CALL option, expiry ", _u(prm.expiry)));
  }

  function transform(
    int[] memory d, bytes calldata p,
    bytes calldata leftArgs, bytes calldata rightArgs,
    uint256 leftTs, uint256 rightTs
  ) internal view override returns (int[] memory) {
    Params memory prm = abi.decode(p, (Params));
    // holder = non-writer side; its args carry the exercise evidence
    bytes calldata args = prm.writerIsLeft ? rightArgs : leftArgs;
    uint256 ts          = prm.writerIsLeft ? rightTs   : leftTs;
    if (args.length == 0) return d;

    (uint16 fill, bytes32 secret) = abi.decode(args, (uint16, bytes32));
    if (fill == 0 || ts > prm.expiry) return d;

    bool exercised = secret != bytes32(0)
      ? keccak256(abi.encode(secret)) == prm.exerciseHash   // same encoding as revealSecret
      : secretRevealedBefore(prm.secretRegistry, prm.exerciseHash, prm.expiry);
    if (!exercised) return d;

    // delta sign convention: negative = LEFT pays (offdelta convention).
    int256 s = prm.writerIsLeft ? int256(-1) : int256(1);  // writer pays base
    d[prm.baseIdx]  += s * int256(fillOf(prm.baseAmount, fill));
    d[prm.quoteIdx] -= s * int256(fillOf(prm.strikeTotal, fill));
    return d;
  }

  function _u(uint256 v) private pure returns (string memory) { /* uint→str */ }
}
```

> Sign conventions above MUST be validated with test vectors against
> `_applyAccountDelta` during implementation — do not trust this doc.

### 2.4 Counterfactual deployment (the cheap-gas story)

Canonical CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`
(already deployed on mainnet/most L2s; deploy once on anvil + BrowserVM genesis).

```
salt          = bytes32(0)                       // identity is the initcode hash
clauseAddress = keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode))[12:]
deploy tx     = { to: deployer, data: salt ++ initcode }   // permissionless, anyone
```

Gas economics:
- propose / approve / resolve / remove: **0 gas** (bilateral frames, off-chain)
- dispute where the clause code is already on-chain (any pair ever deployed the same
  template on this jurisdiction): **0 extra gas**
- dispute with never-deployed custom code: one deploy tx by the finalizer,
  `32k + 200·codeSize + calldata` ≈ **~250k gas for a 2KB clause** — rare path only
- stateless+constructor-less rule ⇒ global dedup: same source ⇒ same address for
  every account pair on the jurisdiction

Wallet pre-checks `eth_getCode(clauseAddress)` and shows “already deployed → dispute
needs no deploy” badge.

### 2.5 The single Depository decision (consensus change, pre-mainnet)

Today `_applyTransformer` forwards all gas and a clause revert bricks the entire
`disputeFinalize` — a malicious/buggy clause can freeze the account forever.

**Recommended (policy K):** per-clause gas cap + skip-on-failure:

```solidity
uint256 constant CLAUSE_GAS_CAP = 1_000_000;
// staticcall{gas: CLAUSE_GAS_CAP}(...);
// on revert/OOG: clause contributes zero diff (deltas unchanged), emit ClauseSkipped
```

Rationale: a skipped clause degrades to the raw offdeltas both parties signed anyway;
max swing already bounded by allowances; removes the only liveness-DoS vector.
Alternative (policy S): ship strict for v1, rely on wallet simulation + lints —
acceptable only if redeploying Depository later is acceptable. Decide before Phase 1
lands. Pre-mainnet ⇒ K is cheap now.

## 3. Runtime layer

### 3.1 State (mostly exists)

`AccountMachine.subcontracts: Map<string, AccountSubcontract>` already flows through
state-root, storage projection/hydration, and proof-builder (`proof-builder.ts:236`).

Extend `AccountSubcontract` with fields needed for counterfactual life:

```ts
interface AccountSubcontract {
  transformerAddress: string;      // CREATE2 address (verified against initcode)
  encodedBatch: string;            // abi.encode(Params)
  allowances: Array<{ deltaIndex, leftAllowance, rightAllowance }>;
  // NEW:
  initcode: string;                // REQUIRED for dispute deploy — must live in signed
                                   // state or finalize is impossible for the honest side
  codeHash: string;                // keccak256(initcode), what humans verify
  solcMeta: { version: '0.8.24'; optimizer: {...} };
  sourceHash: string;              // keccak256(source); source itself is non-consensus,
                                   // exchanged in the propose payload + stored locally
  expiresAt?: number;              // advisory (holds/UI); truth is clause code
}
```

Plus a negotiation area (mirrors the settlement-workspace pattern):

```ts
pendingSubcontracts?: Map<string, PendingSubcontract>; // proposal + who proposed + ts
// cap: max 16 pending, stale proposals expire via existing timestamp checks
```

### 3.2 AccountTx set (new handlers, existing byLeft pattern)

| tx | proposer | effect |
|---|---|---|
| `subcontract_propose` | either | writes pending entry (source travels in payload for verification; only hashes go into pending state). No holds, no financial effect ⇒ safe to auto-ack. |
| `subcontract_approve` | **non-proposer only** (byLeft role check, lending-style) | moves pending → `subcontracts`, adds holds mirroring allowances |
| `subcontract_reject` | non-proposer | clears pending |
| `subcontract_resolve_propose` | either | carries `{id, args, effects: DeltaEffect[]}` — proposer’s claimed outcome (usually from local simulation with real args, e.g. revealed secret + fill) |
| `subcontract_resolve_approve` | non-proposer | applies `effects` to offdeltas, releases holds, deletes clause, writes history entry. `effects: []` ⇒ pure removal (cancel). |

Human-in-the-loop without breaking auto-ack: the **approve is a separate tx from the
counterparty**, gated by its wallet UI/policy. Frames stay auto-ackable because
propose alone changes nothing financial.

Holds on approve (verify signs with test vectors): for each allowance entry, hold the
side that can lose it — `leftAllowance` bounds movement toward LEFT ⇒ hold RIGHT’s
capacity by `leftAllowance`; `rightAllowance` ⇒ hold LEFT’s capacity. Uses the unified
`addHold/releaseHold` model.

Resolve verification policy (no EVM in consensus): the reducer applies whatever both
sides signed. The *wallet* auto-approves a resolve iff local BrowserVM simulation of
`transform(deltas, params, args)` equals the claimed `effects`; otherwise it asks the
human. Consensus stays EVM-free; verification is a wallet policy.

### 3.3 Dispute plumbing

- proof-builder already emits subcontract clauses after the stock clause, sorted by id.
  Argument arrays are positional per transformer index ⇒ dispute args must be assembled
  in the same order (stock Arguments first, then per-subcontract raw bytes, sorted by id).
- `prepareDispute` / `disputeFinalize` entity handlers gain
  `subcontractArgs?: Map<subcontractId, hex>` — filled by the wallet from
  `leftArgsSchema/rightArgsSchema` forms (or by AI).
- jadapter pre-step `ensureClauseDeployed(initcode)`: `getCode(addr) == '0x'` ⇒ send
  deploy tx to canonical deployer, await, then submit finalize. BrowserVM: same against
  the local VM (deployer installed at genesis).
- Watchtower v1 limitation: watchtowers finalize stock clauses only; custom-clause
  finalize is wallet-driven. Roadmap: extend watch package with initcode + prebuilt args.

## 4. Wallet UX

### 4.1 Authoring (proposer)

Account → **Clauses** tab → New clause:

1. Monaco textarea (or template gallery / AI prompt bar: NL → Solidity).
2. Debounced pipeline on every edit:
   - solc-js worker (pinned 0.8.24, vendored + hash-pinned wasm) → inline errors
   - lints: constructor-less, no storage vars, size ≤ 12KB, opcode scan
   - deploy to BrowserVM sandbox → call `paramsSchema()` etc.
3. Auto-rendered below the textarea:
   - **Params form** (from `paramsSchema`) → fills `encodedBatch` live (hex + decoded view)
   - **Dispute-args panel** (from `leftArgsSchema`/`rightArgsSchema`): "При диспуте вы
     предоставляете: …; контрагент предоставляет: fillRatio — сколько исполнить;
     secret — прообраз hash" (descriptions come from the `name:description` schema format)
   - **Simulation**: sliders per argument + timestamp scrubber → live delta before/after
     (real bytecode in BrowserVM, byte-identical to dispute execution)
   - **Envelope sweep** → suggested `allowances` (per-token min/max over argument space;
     oracle inputs bounded by user-set ranges); user may tighten; signed number is binding
   - **Badges**: purity scan (`pure ✅` / `reads 0x… ⚠️` / `contains CALL ❌`),
     bytecode size, deploy-gas estimate, "already deployed on <jurisdiction>: yes/no"
4. “Propose” → `subcontract_propose` (payload carries source + solcMeta for the peer).

### 4.2 Review (counterparty)

Same panels, read-only, plus a verification banner:

- recompiled locally ✅ codeHash match ✅ CREATE2 address match ✅
- `describe(params)` sentence
- worst case in red: “максимум вы теряете: 2500 USDC” (= allowances against you)
- AI audit button: plain-language explanation + adversarial sweep (“при каких args я
  теряю максимум и когда”)
- Approve / Reject / Counter-propose (counter = reject + new propose with edited params)

### 4.3 Life & exit

Active clause card: params summary, expiry countdown, “outcome if disputed now”
(live sim), actions **Resolve / Cancel / Dispute**.

- Resolve: proposer fills its args form → local sim shows effects → sends
  resolve_propose → peer wallet auto-verifies (sim == effects) → auto-approve per
  policy or manual. Holds released, history entry written.
- Cancel: resolve with empty effects; wallet auto-approves after `expiresAt` only if a
  full-arg-space sweep proves the clause is dead (max effect = 0); otherwise manual.
- Dispute: standard prepareDispute flow + args form + ensureClauseDeployed.

### 4.4 AI layer

- **Generate**: NL → Solidity over ClauseBase (templates as few-shot), auto-iterate on
  compile errors.
- **Audit**: explain counterparty’s clause; adversarial argument search via BrowserVM
  brute-force/sweep; flag mismatches between `describe()` and actual `transform` logic.
- **Negotiate** (v2): both wallets’ agents converge on a term sheet (strike/expiry/fees),
  derive identical source from it, verify equal codeHash = agreement reached.

## 5. Phases

**P0 — decide policy K vs S** (only consensus decision; blocks prod, not prototype).

**P1 — contracts:** ClauseBase.sol, CallOption.sol, Escrow.sol; canonical deployer on
anvil/BrowserVM genesis; full dispute e2e test on an unmodified Depository (install →
dispute → CREATE2 deploy → finalize → allowance clamps hold). If K: +~15 lines in
Depository + regenerate typechain + frontend ABI.

**P2 — runtime:** types (§3.1), 5 handlers (§3.2), dispute args threading (§3.3),
jadapter ensureClauseDeployed, storage for pending, scenario test lock-style
(`scenarios/clause-option.ts`) + JSON dumps.

**P3 — wallet:** Clauses tab, solc-js worker, introspection pipeline, sim/sweep panels,
propose/review/resolve/dispute screens.

**P4 — AI + hardening:** generate/audit/negotiate; watchtower custom-clause support;
template registry (curated JSON: source + codeHash + audited-by + deployed-on map).

## 6. Risks / invariants

- **Initcode availability** — initcode lives in signed account state; without it the
  honest side cannot finalize. Non-negotiable.
- **Sign conventions** (delta direction, allowance sides, hold sides) — test vectors
  against Depository before anything ships.
- **Liveness DoS** — solved by policy K; under policy S mitigated only by wallet sims.
- **Comprehension gap** — the real risk is signing code you don’t understand;
  mitigations: allowances (hard bound), describe(), AI audit, envelope sweep.
- **Oracle clauses** — read-only staticcalls allowed by construction; require
  round-pinned reads (roundId in args, clause verifies round timestamp in window),
  failure = no-evidence not revert; wallet trust badges, no protocol whitelist.
- **solc supply chain** — vendor the wasm binary, hash-pin, never fetch at runtime.
- **Pending spam** — cap 16 pending proposals per account, expiry cleanup.
- **Cross-J** — clause evaluates on its own jurisdiction; no cross-chain oracle reads;
  cross-J conditionality only via reveal registry (hashToTimestamp).
