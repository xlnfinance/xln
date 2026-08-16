# FinTS: TypeScript Safety Standard

Status: normative for new and modified first-party TypeScript.

FinTS is xln's coding standard for deterministic financial software. Its goal is
to prevent invalid states, authority confusion, consensus divergence, unsafe
recovery, and accidental fail-soft behavior before code reaches production.

No type system can make a financial protocol perfect. TypeScript guarantees
only apply after untrusted bytes have been decoded and validated. FinTS combines
compile-time modeling, runtime validation, deterministic serialization,
behavioral invariants, replay tests, and fail-stop operations.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 1. Safety hierarchy

When rules conflict, use this order:

1. Financial and authority correctness.
2. Deterministic Runtime -> Entity -> Account replay.
3. Canonical hashes, state roots, wire bytes, and WAL bytes.
4. Crash safety and recovery.
5. Compile-time precision.
6. Convenience and aesthetics.

A prettier type is a regression if it changes bytes, weakens validation, hides
an exception, or creates a second production path.

## 2. Canonical machine boundaries

The three machines have different trust boundaries and MUST remain separate:

| Layer | Live value | Committed state | Input | Transaction | Frame |
|---|---|---|---|---|---|
| Runtime | `RuntimeReplica` | `RuntimeState` | `RuntimeInput` | `RuntimeTx` | `RuntimeFrame` |
| Entity | `EntityReplica` | `EntityState` | `EntityInput` | `EntityTx` | `EntityFrame` |
| Account | `AccountReplica` | `AccountState` | `AccountInput` | `AccountTx` | `AccountFrame` |

Each transition MUST behave as a pure machine:

```text
(replica, validated input, deterministic context) -> { replica, outputs }
```

- Inputs and committed state contain deterministic data only.
- Mempools, retries, candidates, sockets, WAL handles, and watchdogs belong to
  replica or Runtime infrastructure, not committed state.
- Only Runtime performs external effects, and only after its WAL commit.
- Never introduce a generic base reducer across the three layers.
- Never read wall-clock time, randomness, sockets, or mutable global state from
  a reducer. Pass deterministic facts as validated input/context.

### 2.1 Account commitment boundaries

`AccountReplica` is not interchangeable with `AccountState`:

| Value | Bilateral `accountStateRoot` | Parent Entity commitment | Runtime-only |
|---|---:|---:|---:|
| `AccountState` financial fields | yes | through the Account root/frame | no |
| `pendingFrame`, peer input, ACK/resend coordination | no | yes, as Account replica envelope | no |
| transport sockets, retry timers, WAL handles | no | no | yes |

A field may move between these columns only as an explicit protocol migration.
Crash/replay tests MUST cover both the bilateral root and the Entity-owned
replica envelope; equality of one does not prove equality of the other.

## 3. Classify every value before typing it

Every protocol value belongs to exactly one class.

### 3.1 Untrusted bytes

Examples: WebSocket payloads, JSON bodies, LevelDB records, recovery bundles,
RPC responses, environment variables, and files.

- The static type is `unknown` until validation finishes.
- A parser MUST validate exact keys, bounds, formats, cross-field invariants,
  canonical casing, and container types.
- Only the parser may return the trusted or branded type.
- `JSON.parse(...) as T`, `decodeBuffer<T>(...)`, and exported generic
  `deserialize<T>` functions MUST NOT mint protocol authority.
- A terminal `as T` inside a decoder is permitted only when the preceding code
  proves every property of `T`. The decoder requires adversarial tests.

### 3.2 Consensus and durable values

Examples: state, frames, transactions, evidence, Entity context, WAL records,
and objects nested inside them.

- Their runtime shape is part of the protocol.
- Adding, removing, renaming, defaulting, regrouping, or changing the presence
  of a field may change hashes or persisted bytes.
- Container identity is significant. `Map`, object, array, tuple, and set are
  not interchangeable.
- Type-only improvements MUST preserve exact runtime objects and bytes unless
  the change is an explicitly approved protocol-schema milestone.

### 3.3 Ephemeral internal values

Examples: validation results, local effect plans, decoded views, and phase
predicates that are never serialized or hashed.

These are the safest place for discriminated unions, branded identifiers,
closed result types, and exhaustive switches.

## 4. Make illegal states unrepresentable

### 4.1 Closed results, never boolean bags

Financial and consensus code MUST NOT return a boolean plus independent
optional payloads:

```ts
// Forbidden
type Result = {
  success: boolean;
  error?: string;
  secret?: string;
  committedFrames?: AccountFrame[];
};
```

Use a closed union whose payload exists only in the valid branch:

```ts
type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

type HtlcResolveResult =
  | Readonly<{
      ok: true;
      outcome: 'secret';
      secret: HtlcSecret;
      hashlock: Hashlock;
      events: readonly string[];
    }>
  | Readonly<{
      ok: true;
      outcome: 'error';
      reason: HtlcResolutionReason;
      events: readonly string[];
    }>
  | Readonly<{
      ok: false;
      rejection: AccountTxRejection;
      events: readonly string[];
    }>;
```

Rules:

- Rename `success` to `ok` during migration so stale consumers fail compile.
- Do not keep an alias or compatibility result shape.
- Prefer one payload object over many unrelated optional fields.
- A success variant MUST NOT contain an error.
- A rejected variant MUST NOT contain committed financial effects.
- Fatal invariant failures are exceptions, not a `Result` variant.

### 4.2 Existing tags before new tags

Use an existing runtime tag when it already participates in the schema. For a
hash-reachable object, do not add `kind`, `phase`, `status`, or a phantom field
only to improve narrowing.

Prefer negation over new bytes:

```ts
type DraftSettlement = SettlementWorkspace & {
  status: 'draft';
  leftHanko?: never;
  rightHanko?: never;
  settlementHash?: never;
};
```

This is valid only when it describes the existing runtime representation.

### 4.3 Phase views, not phase clones

Draft, proposed, locked, certified, and committed frames may be the same object
as signatures are attached. Model phases with predicates and intersection
views over the same object:

```ts
type LockedEntityFrame = EntityFrame & {
  collectedSigs: Map<SignerId, readonly string[]>;
};

function isLockedEntityFrame(frame: EntityFrame): frame is LockedEntityFrame {
  return frame.collectedSigs instanceof Map && frame.collectedSigs.size > 0;
}
```

- A predicate MUST validate the real phase invariant, not merely field truthiness.
- Do not clone a frame to change its type.
- Do not hash post-commit signatures into a digest that they authenticate.
- Preserve Account and Entity Hanko witness stripping exactly.
- A verified/certified type may be constructed only by its verifier.

Account proposals and ACKs follow the same rule. Their draft/certified views
MUST refine the existing `frameHanko` and optional dispute-seal Hanko fields;
they MUST NOT add a second status or clone the frame to claim certification.

### 4.4 Lifecycle state

Use a stored discriminated union only when the discriminant is already part of
the canonical schema or when an explicit protocol migration approves it.

For presence-in-map lifecycles such as HTLC locks and routes:

- Presence means live; deletion means terminal.
- Do not add a stored terminal status for UI convenience.
- Define narrow predicates for states required by an operation.
- A predicate MUST check all required linked fields, not one boolean.
- UI/history reads terminal history from history storage, not live state.

### 4.5 `EntityInput` remains a multiplexed envelope

`EntityInput` currently passes through a sequential pipeline and merge logic may
legally combine transactions, proposals, precommits, and J-prefix evidence.
Only `leaderTimeoutVote` is required to use a dedicated routed lane today.

Therefore:

- Do not replace the wire/WAL `EntityInput` with a globally exclusive union.
- Create validated extraction views for each processing phase.
- Encode only combination rules already enforced by canonical admission.
- Reconcile routed and locally constructed admission rules before tightening
  any lane combination.
- Maintain a compile-time `keyof` coverage check so every new `EntityInput`
  field is deliberately handled by clone, merge, hash, receipt, and routing.

### 4.6 Account has three authority-distinct inputs

Do not flatten Account input into "just transactions". Preserve three modes:

| Mode | Producer | Bilateral Hanko required |
|---|---|---:|
| local `txs` | owning Entity | no, until proposed as a peer frame |
| peer `frame` / `ack` | bilateral counterparty | yes |
| `external_finality` | authenticated Jurisdiction event | no; peer veto is forbidden |

The decoder and phase views MUST make the selected mode explicit and reject
illegal mixtures. A finality event is authority from Jurisdiction, not an
unsigned peer transaction.

## 5. Brands and units

Brands prevent values with identical primitive representations from being
confused. They do not validate data and disappear at runtime.

### 5.1 Approved brands

Use brands where confusion has protocol consequences:

- `EntityId`, `SignerId`, `RuntimeId`, and jurisdiction identity.
- `ReplicaKey`, `AccountPairKey`, frame/state/evidence hashes.
- `Hashlock`, `HtlcSecret`, token identifier.
- `UnixMs`, `UnixS`, J-height, Runtime height, Entity height, Account height.

Time and height units are especially important. Off-chain milliseconds,
on-chain seconds, and J-height MUST be distinct types at conversion boundaries.

### 5.2 Minting brands

- Only a validating parser, verifier, or canonical constructor may mint a brand.
- Production `as EntityId`, `as Hashlock`, or equivalent casts are forbidden.
- Parser output remains branded only while all structural operations preserve
  its guarantee.
- Do not expose a generic `brand<T>()` escape hatch.
- Enforce allowed mint modules with an AST gate.

### 5.3 What not to brand

- Do not brand every `bigint` amount. Financial arithmetic must remain usable
  through canonical formulas such as `deriveDelta`.
- Do not encode numeric range validation at the type level. Runtime values are
  not literals and still need validation.
- Do not make `SignerId` an EVM address if the protocol also allows aliases.
- Do not propagate a brand through hundreds of sites without a demonstrated
  confusion risk. Boundary brands and domain-focused propagation provide most
  of the value.

## 6. Type-level programming policy

### 6.1 Approved techniques

Use simple techniques that both TypeScript 5 and native TypeScript 7 can
compile predictably:

- discriminated unions;
- intersections and `?: never` for existing shapes;
- user-defined type predicates;
- `as const satisfies` for canonical catalogs and transition tables;
- mapped types for exact field coverage;
- conditional types for shallow compatibility checks;
- template-literal types for canonical compound identifiers;
- non-empty tuples such as `[T, ...T[]]`;
- `keyof` residual checks;
- `assertNever` for exhaustive control flow;
- `Readonly` and readonly arrays at pure boundaries.

Example of a catalog that is runtime data and a literal type source:

```ts
const ENTITY_REJECTION_CODES = {
  malformedInput: 'ENTITY_INPUT_MALFORMED',
  authorityMismatch: 'ENTITY_AUTHORITY_MISMATCH',
} as const satisfies Record<string, string>;

type EntityRejectionCode =
  (typeof ENTITY_REJECTION_CODES)[keyof typeof ENTITY_REJECTION_CODES];
```

### 6.2 Rejected techniques

- deep recursive conditional types;
- type-level financial arithmetic;
- compiler-recursion workarounds;
- generated APIs that require `@ts-expect-error` or unchecked casts;
- phantom states instantiated with `{ } as State`;
- clever types whose TS5 and TS7 behavior differs;
- generic abstractions that obscure the R/E/A trust boundary;
- utility types that silently make protocol fields optional;
- `Partial<ProtocolType>` as a builder.

If a type takes longer to understand than the invariant it protects, use a
small validated constructor and a direct union instead.

## 7. Exact constructors and decoders

Every important union or evidence shape SHOULD have one owning constructor or
decoder module.

The constructor MUST:

1. accept already validated dependencies;
2. validate cross-field invariants;
3. construct exact keys, omitting absent keys rather than assigning undefined;
4. preserve canonical container types;
5. return one precise union variant;
6. perform no I/O, time reads, or randomness inside a reducer;
7. never return a partial object.

The return type MUST be the narrowest phase that the constructor proves. A
constructor that can only create `UnsignedSettlementWorkspace` must not return
the wider `SettlementWorkspace`, because that discards a fact the caller needs
to make illegal transitions unrepresentable.

AST gates SHOULD forbid direct discriminant-bearing object literals outside the
owner module when that pattern is practical.

Decoder tests MUST include:

- unknown keys;
- missing required keys;
- wrong container types;
- unknown tags/status strings;
- noncanonical casing and identifiers;
- duplicate, unsorted, empty, and over-limit collections;
- own-key `undefined` where forbidden;
- values that are individually valid but invalid in combination.

## 8. Serialization and hashing

TypeScript structure is not the serialization contract. xln has multiple
encoders with intentionally different behavior:

| Encoder | `undefined` object field | Map behavior | Main use |
|---|---|---|---|
| `encodeCanonicalConsensusValue` | preserved as a tagged value; differs from missing | canonical, type-sensitive | Entity/frame consensus hashes |
| tagged JSON / `safeStringify` | omitted | tagged and sorted; undefined entries omitted | logs, APIs, portable JSON |
| Account canonical RLP | omitted | committed through canonical map roots | Account state roots |
| canonical msgpack WAL | preserved | sorted by canonical key bytes | durable Runtime history |

Consequences:

- Never assume missing and own-key `undefined` are equivalent.
- Do not replace conditional spreads with `field: maybeUndefined`.
- Do not replace `Map` with `Record`, or vice versa.
- Do not change array/tuple, typed-array, Date, bigint, or number representation
  as a type-only cleanup.
- Never use raw `JSON.stringify` for financial or protocol state.
- Never regenerate a golden hash merely to make a type refactor pass.
- Field ordering, canonical sorting, casing, and omission rules are protocol
  rules and require tests.

Nested values need coverage too. Top-level state-field coverage is insufficient
when `Delta`, `SettlementWorkspace`, `HtlcRoute`, a lock, or transaction payload
is structurally encoded. Every hash-reachable nested type MUST have either:

- an explicit canonical projection/field list with compile-time coverage; or
- an independently maintained golden codec fixture that fails on field drift.

Solidity coverage is codec coverage. Every runtime `ProofBody`, `Payment`,
`Pull`, settlement, and dispute projection MUST be checked against its exact
ABI field set, ordering, signedness, left/right convention, and inclusive or
exclusive deadline semantics. TypeScript field coverage alone cannot prove
contract parity.

## 9. Errors and failure containment

### 9.1 Error classes

Errors have four categories:

```ts
type FailureDisposition =
  | 'reject'
  | 'retry'
  | 'dispute'
  | 'halt_runtime';
```

1. **Reject**: authenticated or unauthenticated external input is invalid. Return
   a typed rejection code. Do not mutate committed state.
2. **Retry/defer**: a known temporary condition occurred before commit. Return a
   typed reason with bounded retry policy.
3. **Dispute**: authenticated signed evidence cannot be safely discarded or
   replayed as an ordinary peer input. Persist the exact evidence and start the
   canonical on-chain dispute path. Clock mismatch alone is never this case.
4. **Halt Runtime**: invariant violation, storage corruption, replay divergence,
   impossible authority state, or unknown exception.

Control flow MUST NOT depend on `message.startsWith`, `includes`, regexes over
human text, or emoji. Use a literal `code`, typed payload, and `instanceof` at
the trust boundary. Log messages may remain stable for operators but are not
the machine taxonomy.

This is enforced structurally: production catch/classifier code may inspect a
typed disposition or an exact code catalog, never `error.message`. Before a
mainnet candidate, every expected failure at a money/authority boundary MUST
be categorized; an uncategorized failure still halts only the affected Runtime.

### 9.2 Fail-stop Runtime, live host

An invariant failure does not need to crash the entire multi-Runtime host, but
the affected Runtime MUST NOT continue applying inputs.

The outer supervisor MUST:

1. abort the candidate and publish no uncommitted state or effects;
2. preserve the authoritative WAL and full incident dump;
3. transition that Runtime to `HALTED_REQUIRES_OPERATOR`;
4. stop its scheduling, ingress, signing, routing, and jurisdiction outputs;
5. keep read-only health and inspection available;
6. require explicit operator restart/replay to resume.

Unknown exceptions halt the affected Runtime. They MUST NOT be guessed to be
"nonfinancial" and swallowed. Expected peer failures are modeled as reject or
retry results and never reach this boundary.

### 9.3 Never swallow errors

- Catch only errors whose exact typed disposition is understood.
- Rethrow unknown errors.
- Never use `.catch(() => null)` in an authority, financial, storage, or
  consensus path.
- Never convert a failed mutation into a successful no-op.
- Error telemetry failure must not hide the original error.

## 10. Financial and authority invariants

### 10.1 Financial math

- Use `deriveDelta(delta, isLeft)` for credit/capacity views.
- Do not hand-read left/right credit fields to invent viewer math.
- Do not add a second balance, capacity, settlement, or fee formula.
- Token IDs and row caps are validated at the canonical mutation sink and at
  untrusted boundaries.
- Signed semantics are rejected on duplicates; never silently deduplicate.
- Perform canonical before/after simulation for capacity-sensitive operations.
- Conservation and bounds require executable invariants, not types alone.
- `byLeft`, `iAmLeft`, and `senderIsLeft` are different authorities. Derive
  them at their exact frame/account boundary and never substitute one for
  another merely because all three are booleans.

### 10.2 Authority

- Consensus verification uses authority from the exact observer-certified
  registry root, never "latest board found anywhere locally".
- Discovery/gossip resolvers and consensus authority resolvers are separate APIs.
- Current-board-only and historical-previous-board authority are explicit
  types/modes; omission must not silently broaden authority.
- Nested Hanko claims resolve against the same observer authority context.
- A verified type is constructed only after cryptographic and semantic checks.
- Signature presence is not certification; threshold, identity, domain, nonce,
  and signed hash must all be validated.
- Socket liveness is an unverified observation owned by the active proposer.
  When it affects frame construction, the exact observation MUST be committed
  as proposer evidence so validators replay the same bytes; it MUST NOT be
  relabeled as quorum-verified truth or used as financial authority.

### 10.3 Time and deadline parity

- Off-chain milliseconds, on-chain seconds, J-height, and frame timestamps are
  distinct units.
- Inclusive/exclusive conversion is named and tested at aligned and unaligned
  boundaries.
- Preflight and mutation MUST agree on the clock and disposition.
- Honest bounded skew must not automatically create an on-chain dispute.
- Late authenticated secret evidence may require dispute handling; mere clock
  mismatch does not.

### 10.4 Atomic groups and retries

- Atomic cohorts are represented as one persisted coordinator state, not
  independent optional legs.
- An incomplete cohort is bounded, retryable, or atomically cancelled before
  any leg is sent.
- Restore flags MUST have a deterministic clearing condition.
- Retry schedulers MUST not spin at timestamp zero on unattemptable work.
- Exact replay is idempotent and cannot create new financial effects.

### 10.5 Entity apply ownership

- Threshold-one Entity application mutates the owned live candidate path.
- Multi-signer application isolates a candidate until certification succeeds.
- A throw on the threshold-one path is not a discardable malformed peer input:
  abort publication, preserve WAL authority, and halt the affected Runtime.
- Tests MUST cover both modes and prove identical committed bytes/effects for
  equivalent certified inputs.

### 10.6 Persistent candidates, never machine clones

Runtime and Entity state are unbounded financial indexes. Their candidate and
durability paths MUST use persistent overlays and dirty Merkle branches; a
frame may never copy or traverse the whole machine merely to isolate a
candidate, compute a root, or append the WAL.

- `RuntimeReplica` and `RuntimeState` are never cloned.
- `EntityReplica`, `EntityState`, their Account map, and their orderbook maps
  are never cloned as a unit. Reads do not claim or copy values for mutation.
- Candidate writes path-copy only the touched branch and replace its hashes up
  to the committed root. Certification publishes that overlay atomically;
  rejection drops it without mutating committed state.
- `AccountReplica` and `AccountState` are not cloned. Account, Entity, Book and
  Runtime overlays are separate ephemeral transition caches outside every
  committed `*State` and live `*Replica`; an Entity candidate receives only the
  resulting touched Account roots/nodes, never ownership of Account overlays.
- An overlay cache key binds machine identity, committed base root, and the
  ordered input-prefix/proposed-frame hash. It may be evicted at any time and
  MUST deterministically rebuild from the committed root plus authoritative WAL
  inputs. Certification publishes only immutable nodes and the new root;
  rejection drops the cache without cleanup writes.
- Live replicas contain no historical frame/order/event collections. Runtime,
  Entity and Account certified frame histories are separate LevelDB/WAL logs
  read on demand. Live state retains only the current committed head/root and
  bounded in-flight coordination required to finish that head.
- WAL frames retain the applied input and compact commitments. Full Runtime or
  Entity snapshots are not constructed on the frame path; checkpoint writers
  stream immutable CAS nodes already reachable from committed roots.
- Any new clone of a Runtime/Entity/Book object, including through a helper or
  clone-on-read collection, is a product-gate failure.

The canonical overlay API follows the cascade instead of pretending that all
roots have the same authority:

- `beginEntityOverlay` is owned by the Entity transition coordinator.
- `beginAccountOverlay` may run only as a nested child of that Entity overlay.
  An Account root is independently authenticated by the bilateral Account
  frame, but it has no independent WAL, snapshot, cursor, or durable publish
  step. Runtime remains the only durable writer.
- Financial handlers receive a branded synchronous draft view. They can read,
  edit, insert, delete, and range-scan their typed prefix lenses; they cannot
  import or invoke prepare, publish, commit, or discard.
- A read is dirty-first and allocation-free. An edit receives a deeply
  readonly old leaf and must return a different value. The owning codec copies,
  validates, bounds, and seals that value before it can enter the candidate.
- The machine consumes the overlay exactly once. Use-after-prepare,
  use-after-discard, stale-base publication, and inserting an open Account
  draft into an Entity candidate are hard errors.

TypeScript has no linear types, so nominal brands and dependency gates enforce
the ownership visible to the compiler while one runtime lifecycle token closes
the remaining double-use case. Proxy traps, weak collections, `Map`
subclassing, ambient caches keyed by committed objects, and handler-visible
lifecycle functions are prohibited.

Root composition is lifecycle-partitioned. Small fixed trust-boundary records
bind child roots; path-compressed Patricia maps exist only below growing
collection slots. `AccountReplicaRoot` binds the bilaterally signed
`AccountStateRoot` and the bounded Entity-certified Account envelope root.
`EntityStateRoot` binds its bounded header, Account-replica index root, unified
same/cross order-book root, and other typed collection roots. Book pages share
the Entity lifecycle and therefore are not a separate durable machine.

## 11. Compiler and static-analysis policy

Runtime compiler options MUST retain:

- `strict`;
- `noUncheckedIndexedAccess`;
- `exactOptionalPropertyTypes`;
- `noImplicitReturns`;
- `noPropertyAccessFromIndexSignature`;
- `noFallthroughCasesInSwitch`;
- `noUnusedLocals` and `noUnusedParameters`;
- unreachable-code and unused-label rejection.

Frontend enables the same options incrementally by directory. A frontend
unused-code cleanup is a standalone change, never bundled with consensus types.

Required AST/static ratchets:

- no new explicit `any`, double assertion, TS suppression, or unchecked brand cast;
- no boolean+optional result bags in financial/consensus modules;
- no string-prefix control flow;
- no raw protocol object construction outside owning constructors;
- no unvalidated raw decode at authority boundaries;
- no new hash-reachable nested field without coverage;
- exhaustive switches over protocol unions;
- canonical architecture dependencies and no Runtime/Entity/Account inversion;
- no randomness, wall-clock reads, or timers in deterministic reducers;
- no raw JSON serialization of protocol state;
- no compatibility aliases or parallel production paths.

Type coverage MAY be ratcheted upward per protocol directory. It MUST NOT reward
casts, `unknown` laundering, or generated declarations that are never used.

## 12. Type-level tests

`@ts-expect-error` and other suppressions are forbidden. After Milestone 4
closes the first financial result unions, new authority-bearing types SHOULD
use a dedicated negative compiler harness. This harness is not a Milestone 0
gate:

1. a fixture contains one intentionally illegal construction;
2. the fixture is included in an explicit negative-test tsconfig;
3. the harness requires compilation to fail;
4. it verifies the expected diagnostic file/location or stable diagnostic class;
5. a paired positive fixture must compile;
6. a mutation check widens the target type and proves the negative fixture
   would stop constraining it.

Also use positive type equalities and field coverage:

```ts
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

type Expect<T extends true> = T;
type Covered = Expect<Equal<keyof HtlcRoute, HtlcRouteField>>;
```

A multiplexed protocol envelope needs coverage by operation, not merely one
top-level `keyof` assertion. `EntityInput` must account for every field in its
clone, merge, hash, receipt, and routing policies. Adding a field without an
explicit decision on all five axes is a compile-time failure.

Keep utilities shallow and compatible with both supported TypeScript compilers.

## 13. Verification ladder for every milestone

### L1: exact local proof

- Type checker and new static ratchet.
- Positive and negative type fixtures.
- Decoder adversarial cases.
- Closest reducer unit tests.
- Golden bytes for every affected codec.
- Exact state-root/frame-hash/authority-root literals unchanged for byte-neutral work.

### L2: targeted flow

- One real R/E/A transition through the changed boundary.
- Differential old/new replay from the same input bytes.
- WAL restore fixture and canonical post-state hash.
- Crash at the relevant pre-WAL/post-WAL boundary.
- On-chain/off-chain parity test when Solidity semantics are involved.
- Mutation test for the financial predicate or illegal-state constraint.

### L3: broad evidence

- Related canonical unit/integration suite.
- Required browser bundle.
- Frontend typecheck/build when public types changed.
- Isolated browser E2E and F12 console for user-visible behavior.
- `bun run check` once on the unchanged final candidate.

Do not rerun L3 while an L1/L2 failure is still being localized.

## 14. Golden and differential evidence

Byte-neutral milestones MUST preserve:

- canonical Account state root and section hashes;
- Entity state root and authority root;
- AccountFrame and EntityFrame hashes;
- Hanko domains and encoded evidence;
- WebSocket/wire canonical hashes;
- tagged JSON, Account RLP, canonical consensus, and msgpack fixtures;
- WAL frame, post-state, and canonical Runtime state hashes;
- replayed outputs and receipts.

Do not use the production encoder to generate the expected golden in the same
test. Expected literals come from an independent oracle or previously approved
fixture.

Differential replay compares, at minimum:

```text
same persisted RuntimeInput bytes
  -> same RuntimeState
  -> same Entity/Account roots
  -> same outputs/effects
  -> same WAL post-state hash
```

## 15. Smooth migration method

Each milestone is one coherent, independently revertible commit. No adapters,
V2 aliases, parallel readers, or compatibility branches survive the commit.

The implementation through Milestone 11 is present on the current candidate.
Completion is executable, not editorial: `bun run soundcheck:fast` owns the
fast FinTS policy, `bun run check` owns the complete source/build gate, and the
release E2E profiles own browser/runtime evidence. A checked milestone may not
be claimed while any owning gate is red.

| FinTS invariant | Executable owner |
| --- | --- |
| Strict compiler/module policy | `check:fints-compiler-policy` |
| Decoder-only brand minting and negative types | `check:fints-negative-types` |
| No unsafe casts, suppressions, new non-null debt, or JS-error guessing | `check:unsafe-types` |
| Determinism, including randomness, clocks, and weak collections | `check:determinism:static`, `check:no-weak-collections` |
| Dependency direction and dead surface | `check:runtime-dependencies`, `check:dead-code`, `check:unused-surface` |
| Hash-reachable field coverage | `check:nested-hash-coverage` |
| Persistent Runtime/Entity candidates; no full-machine clones | `check:no-machine-clones` |
| Typed failure disposition and fail-stop | `security:failure-taxonomy` |

### Milestone 0: behavioral prerequisites

Before type reshaping, fix and test active correctness blockers on the same
surfaces, including:

- [x] observer-root Hanko authority;
- [x] incomplete cross-j atomic cohort recovery/hot-loop;
- [x] equal-HEAD current-cache verification and healing;
- [x] O(height) key recovery when authoritative snapshot seeds exist;
- [x] HTLC runtime/Solidity deadline parity and clock disposition;
- [x] duplicate forgiveness runtime/Solidity parity;
- [x] remaining known fail-soft HTLC payment/resolve transitions;
- [x] retired cross-token global credit-limit consensus state.

These boxes describe the current candidate, not a completion claim. They become
authoritative only after Milestone 1 records a green immutable SHA and the
required behavioral regressions.

### Milestone 1: freeze the baseline

- Commit the current semantic protocol refactor first.
- Run L1/L2, canonical browser build, and `bun run check`.
- Pin multi-codec missing-vs-undefined and Map-order fixtures.
- Pin current legal EntityInput combinations and both local/routed admission rules.
- Record differential WAL replay outputs.

### Milestone 2: close hash-coverage gaps

- Add compile-time field coverage for nested hash-reachable values.
- Cover `Delta`, locks, `SettlementWorkspace`, `HtlcRoute`, evidence, and
  transaction payloads.
- Add AST detection for unclassified nested field additions.
- Runtime behavior and bytes remain unchanged.

### Milestone 3: validate existing lifecycle tags

- Replace unchecked status casts, especially cross-j status fallback.
- Reject unknown persisted/wire states loudly.
- Preserve existing canonical tags and transitions.

### Milestone 4: close financial result unions

- Atomically migrate `ApplyAccountTxResult`, Account consensus results, and
  direct handler results.
- Rename-to-break; migrate every producer and consumer; delete old types.
- Prove rejected paths have no state/root/effect mutation.

### Milestone 5: typed failure taxonomy and Runtime fail-stop

- Replace the small set of actual string-controlled branches first.
- Introduce exact typed dispositions: reject, retry, dispute, halt Runtime.
- Add Runtime supervisor isolation and `HALTED_REQUIRES_OPERATOR` behavior.
- Keep unknown invariant/storage errors fail-stop.
- Test one Runtime halting while the host remains observable.

### Milestone 6: decoder-minted brands and units

- Reuse the canonical identity module.
- Brand at WS, Entity-input, WAL, storage, recovery, and control decoders.
- Add `UnixMs`/`UnixS` and height distinctions at conversion points.
- Propagate inward only where a real confusion bug is plausible.

### Milestone 7: evidence and frame phase views

- Add draft/locked/certified intersection views and predicates.
- Preserve object identity, mutation timing, digest exclusions, and Hanko stripping.
- Tighten output `never` fields already represented in the wire schema.

### Milestone 8: settlement, dispute, and candidate typestate

- Use existing status fields plus `?: never` to forbid invalid combinations.
- Keep root-reachable fields flat when nesting would change bytes.
- Add predicates where the stored representation cannot safely become a union.

### Milestone 9: HTLC narrow views

- Keep presence-in-map terminal semantics.
- Add predicates for forwarding, final recipient, secret-ack, and dispute-ready states.
- Do not add a stored route status.
- Prove target-only secret disclosure and upstream propagation ordering.

### Milestone 10: EntityInput phase views

- Unify local and routed well-formedness rules where behavior should match.
- Keep the multiplexed wire envelope unless an explicit protocol change replaces it.
- Provide exact phase extraction views and field-coverage ratchets.
- Preserve merge, split, receipt, priority, and sequential processing semantics.

### Milestone 11: remaining strictness

- Enable frontend unused checks directory by directory.
- Ratchet type coverage for Account, Entity, Runtime, protocol, and storage.
- Remove newly exposed dead adapters and exports.
- Run scoped mutation testing on changed financial reducers.

## 16. Stop and rollback criteria

Immediately stop and revert the milestone if any of these occur without an
explicitly approved protocol change:

- golden hash, root, wire byte, WAL byte, or Hanko domain changes;
- differential replay diverges;
- a previously rejected malformed input becomes accepted;
- a fatal invariant becomes a soft success;
- a peer rejection becomes Runtime halt or automatic dispute;
- a local candidate publishes an effect before WAL commit;
- a new cast or suppression is needed to make the type compile;
- TS5 and TS7 disagree;
- a compatibility path is required to land the change;
- broad tests reveal a semantic change not covered by L1/L2.

Rollback is `git revert` of the single milestone commit. Do not patch around a
failed milestone with aliases or fallback readers.

## 17. Pull-request checklist

### Model

- [ ] Invalid combinations are unrepresentable or rejected by one exact decoder.
- [ ] Results are closed unions, not boolean bags.
- [ ] Every switch is exhaustive.
- [ ] Every brand is minted only by its owner.
- [ ] No `Partial`, cast, or suppression bypasses construction.
- [ ] Fatal invariants cannot become peer rejections or successful no-ops.

### Determinism and bytes

- [ ] No new time, randomness, timer, socket, or global-state read in R/E/A.
- [ ] No container or optional-key presence change is disguised as typing.
- [ ] Nested hash-reachable fields have coverage.
- [ ] All affected codec goldens are unchanged or explicitly approved.
- [ ] WAL differential replay is identical.

### Finance and authority

- [ ] Canonical Delta/capacity math is reused.
- [ ] Duplicate signed semantics reject loudly.
- [ ] Exact signer, role, nonce, domain, and observer authority are derived.
- [ ] Current/previous authority policy is explicit.
- [ ] On-chain/off-chain boundary and unit parity are tested.
- [ ] Retry/atomic-group recovery is bounded and non-spinning.

### Evidence

- [ ] L1 is green.
- [ ] L2 targeted flow is green.
- [ ] Browser/public API checks are green when affected.
- [ ] `bun run check` is green on the unchanged candidate.
- [ ] No golden was regenerated to bless the implementation.

## 18. Human review order

Review a protocol change in this order:

1. Authority: who may create, sign, accept, reject, and finalize it?
2. State ownership: Runtime, Entity, Account, or Jurisdiction?
3. Input bytes and decoder: what exact untrusted value reaches the machine?
4. Transition: what state and effects change on success, reject, retry, and throw?
5. Commitment: which hash/root/WAL record binds the change?
6. Replay: can the exact input be applied twice or after restart?
7. Atomicity: can one leg/state/effect commit without the others?
8. Enforcement: what on-chain behavior must exactly match?
9. Recovery: what happens at every crash boundary?
10. Observability: can operators distinguish reject, retry, dispute, and halt?

Only after these questions are answered should a reviewer judge local code
style or abstraction quality.

### 18.1 xln module reading order

An independent protocol reviewer SHOULD read modules in this order. The order
follows financial authority and irreversible effects, not directory size:

1. `runtime/account/consensus`, `runtime/account/tx`, `runtime/account/state`,
   `runtime/types/account.ts`: bilateral authorization, Delta math, locks,
   settlement, lending, replay, collision, and Account root ownership.
2. `runtime/protocol/dispute`, `runtime/protocol/settlement`,
   `jurisdictions/contracts`: exact off-chain/on-chain parity, ProofBody,
   transformer execution, deadlines, nonces, and Hanko domains.
3. `runtime/entity/consensus`, `runtime/entity/tx`, `runtime/entity/auth`:
   validator authority, candidate isolation, child Account inputs, frame
   certification, and single-signer versus threshold application.
4. `runtime/hanko`, `runtime/board-registry`: current/previous board authority,
   nested claims, observer-root binding, signer roles, and grace windows.
5. `runtime/runtime`, `runtime/frame`, `runtime/storage`: single-writer ordering,
   WAL-before-effects, crash recovery, cache healing, replay, and publication.
6. `runtime/extensions/cross-j`, `runtime/routing`, `runtime/network`:
   two-leg atomic groups, reliable delivery, retry bounds, authenticated
   transport, gossip evidence, and unverified online assertions.
7. `runtime/entity/profile`, `runtime/orchestrator`, `runtime/api`: route/profile
   certification and ingress boundaries. Review UI/CLI last; they must not own
   protocol calculations or financial authority.

For each group, read the production transition first, then its state/root or
codec, then the closest adversarial L1, then one restart/on-chain L2. Never infer
the protocol solely from tests, docs, generated bundles, or UI projections.

## 19. References

The following articles provide useful background, but this document overrides
their examples where xln's deterministic protocol requires stricter rules:

- Khalil Stemmler, “Make Illegal States Unrepresentable”.
  <https://khalilstemmler.com/articles/typescript-domain-driven-design/make-illegal-states-unrepresentable/>
- “Making Impossible States Impossible with TypeScript”.
  <https://dev.to/lieberkind/making-impossible-states-impossible-with-typescript-3hj>
- Andrei Chmelev, “Type-Level Programming in TypeScript”.
  <https://medium.com/@an.chmelev/type-level-programming-in-typescript-practical-use-cases-and-overview-of-capabilities-cb239770fa85>
- Michael Matos, “Typelevel TypeScript: A Cheat Sheet”.
  <https://dev.to/eatyourabstractions/typelevel-typescript-a-cheat-sheet-2d80>
- Michael Matos, “Typelevel TypeScript: A Practical View”.
  <https://dev.to/eatyourabstractions/typelevel-typescript-a-practical-view-1j1m>

Use these for concepts, not copy-paste. Some examples rely on unchecked casts,
`@ts-expect-error`, or type-level arithmetic that FinTS explicitly forbids.
