# H-01 — Previous-board grace authorizes NEW dispute evidence

| Field | Value |
|---|---|
| Severity | **High** |
| Confidence | **High** (verified on-chain, exploit reproduced) |
| Scope | Solidity (`jurisdictions/contracts`) + runtime (`runtime/`) |
| Status | **Live vulnerability** — PoC asserts the attack succeeds today |
| Reproducible PoC | `jurisdictions/test/H01-PreviousBoardGraceExploit.test.ts` |

---

## 1. Executive summary

XLN's seven-day board-rotation grace window is meant to keep **already-signed
historical bilateral evidence** enforceable after a board rotates. It instead
authorizes **freshly-forged evidence**: because the signed dispute-proof payload
carries no anchor tying it to the board generation that signed it, the verifier
cannot tell a signature made *before* rotation from one made *after*. A
compromised old-board quorum can therefore sign an arbitrary new dispute proof
during the grace window, and a malicious counterparty can use it to reallocate
bilateral collateral/reserves or create debt against the entity — authority the
entity believed it had revoked by rotating.

This is not theoretical. The regression suite at
`jurisdictions/test/BoardRotationGrace.test.ts:355` already performs the exact
attack sequence and asserts it as **passing** (intended behavior). The PoC below
reproduces it with the framing inverted to make the vulnerability explicit.

---

## 2. Root cause (cryptographic)

### 2.1 The signed dispute-proof payload binds nothing to a signing time

`HankoEncoding.encodeDisputeProof` (`jurisdictions/contracts/HankoEncoding.sol:36-53`)
encodes only:

```
(MessageType.DisputeProof, chainId, contractAddress, accountKey, nonce,
 proofbodyHash, watchSeed)
```

There is **no pre-rotation anchor** in this digest:

- no `boardEpoch` / board generation counter,
- no board hash,
- no rotation timestamp,
- no domain separator tying the digest to "this board signed me."

The codebase already knows the anchoring pattern: governance payloads
(`encodeBoardProposal`, `encodeEntityTransfer`, `encodeReleaseControlShares`)
**do** include a `boardEpoch`. It was simply omitted for dispute proofs.

Consequence: the signature itself records nothing about *when* it was produced.
A byte-for-byte identical signed message can be created the day before rotation
or six days after — the contract cannot distinguish the two.

### 2.2 The grace check uses only a runtime clock, not a signed value

`HankoVerifier._boardMatches` (`jurisdictions/contracts/HankoVerifier.sol:234-247`):

```solidity
function _boardMatches(
    Entity storage entity, bytes32 entityId, bytes32 boardHash, bool currentOnly
) private view returns (bool) {
    if (entity.currentBoardHash == bytes32(0)) return entityId == boardHash;
    if (boardHash == entity.currentBoardHash) return true;
    return
      !currentOnly &&
      boardHash == entity.previousBoardHash &&
      boardHash != bytes32(0) &&
      block.timestamp < entity.previousBoardValidUntil;   // 7-day window
}
```

The **only** freshness gate is `block.timestamp < entity.previousBoardValidUntil`
— a runtime value supplied by the block, not a value inside the signed message.
Combined with §2.1, the verifier accepts a previous-board signature for any
account/nonce/proofbody the old key chooses to sign, for the full seven days,
because nothing in the payload contradicts "this was signed before rotation."

### 2.3 The dispute-proof path deliberately uses the grace-accepting verifier

`EntityProvider.verifyHankoSignature` passes `currentOnly = false`
(`jurisdictions/contracts/EntityProvider.sol:656-661`):

```solidity
function verifyHankoSignature(bytes calldata hankoData, bytes32 hash)
    external view returns (bytes32 entityId, bool success) {
    return HankoVerifier.verify(entities, hankoData, hash, false);   // currentOnly = false
}
```

`Account.verifyDisputeProofHanko` routes dispute-proof verification through that
grace-accepting entrypoint (`jurisdictions/contracts/Account.sol:389-403`), and
the dispute-start path does the same inline
(`jurisdictions/contracts/Account.sol:1062-1064`). The inline comment at
`Account.sol:399-401` documents this as *intentional*:

> This verifies historical bilateral evidence. Previous-board signatures must
> remain valid during the grace window or a board rotation could erase an
> already signed account state before either side can enforce it.

That rationale is correct for **case (a)** — genuinely historical evidence — but
the implementation cannot distinguish it from **case (b)** — freshly forged
evidence. The design conflates the two.

---

## 3. Why the design is broken: the two cases it cannot separate

| Case | What it is | Should be accepted? |
|---|---|---|
| (a) Historical | A proof signed *before* rotation, submitted during grace because the rotating side needed time to enforce it. | **Yes** — this is what grace is for. |
| (b) Forged | A proof signed *after* rotation, by a compromised old key, over a nonce/body that never existed pre-rotation. | **No** — this is a key the entity revoked. |

Because the signed payload has no pre-rotation anchor (§2.1) and the grace gate
is only `block.timestamp` (§2.2), the verifier treats both cases identically.
The attacker chooses the nonce, the proofbody, and the watch seed at signing
time — all are attacker-controlled inputs that did not exist before rotation.

---

## 4. Attack scenario

1. A board quorum's signing key material is compromised.
2. Governance detects this and rotates to a safe board. The old board's hash
   moves into `previousBoardHash` with `previousBoardValidUntil = now + 7 days`.
3. During the grace window, the compromised quorum signs a **fresh**, never-used
   higher-nonce bilateral dispute proof (any `accountKey` / `nonce` /
   `proofbodyHash` it wants) with the old key.
4. A malicious counterparty wraps that inner signature in its own **current-board**
   outer batch (which the contract accepts as fresh transport authority) and
   submits `processBatch`. The contract emits `DisputeStarted`.
5. Once the dispute is open, finalization can land **after the challenge delay
   even if the grace window has since expired** — finalization only requires the
   dispute to already exist; the inner finalization signature is again verified
   via the grace-accepting path.

Impact: reallocation of bilateral collateral/reserves or creation of debt
against the entity using authority the entity believed it had revoked.

---

## 5. Reproducible exploit

**File:** `jurisdictions/test/H01-PreviousBoardGraceExploit.test.ts`

The PoC reproduces both halves of the attack against real contracts (no mocks):

- **ATTACK A** — after rotation, a brand-new dispute is opened with a signature
  from the **revoked old key** over a nonce that was never used pre-rotation.
  Asserts `DisputeStarted` is emitted and the account nonce advances.
- **ATTACK B** — a dispute is opened legitimately with the current key, then
  **finalized at a higher nonce** with a signature from the **revoked old key**
  (a finalization proof that did not exist before rotation). Asserts
  `DisputeFinalized` is emitted and the account advances to the forged nonce.

### Reproduction

```bash
cd jurisdictions
bunx hardhat compile
bunx hardhat test test/H01-PreviousBoardGraceExploit.test.ts
```

> Environment note: this repository mandates `bun` (`AGENTS.md`). The Hardhat
> toolchain itself is Node-based; if `bun` is unavailable the same result is
> obtained with `npx hardhat ...` on Node ≥20 (<23 per `package.json`).

### Captured output (vulnerability confirmed)

```
  H-01 EXPLOIT — previous-board grace authorizes new dispute evidence
    ✔ ATTACK A: opens a NEW dispute signed by the previous (revoked) board key during grace (385ms)
    ✔ ATTACK B: finalizes a dispute with a fresh higher-nonce proof signed by the previous board key (63ms)


  2 passing (449ms)
```

Both assertions **succeed** — i.e. the contract accepts the revoked key's
authority. That is the vulnerability.

### Why the existing suite does not catch it

`jurisdictions/test/BoardRotationGrace.test.ts:355` ("rejects previous-board
money actions but accepts its signed dispute proof") performs the **same**
sequence and asserts the old-key dispute **succeeds**, treating it as intended
behavior. The comment at `BoardRotationGrace.test.ts:509-510` frames old-key
finalization of a fresh higher nonce as "evidence survives rotation." The
vulnerability is documented as a feature; only the security interpretation is
missing.

---

## 6. Affected code paths

### 6.1 Contract layer (`jurisdictions/contracts/`)

| Location | Role |
|---|---|
| `HankoEncoding.sol:36-53` | `encodeDisputeProof` — payload has **no** pre-rotation anchor. |
| `HankoVerifier.sol:234-247` | `_boardMatches` — grace gated only by `block.timestamp`. |
| `EntityProvider.sol:656-661` | `verifyHankoSignature` — `currentOnly = false` (grace-accepting). |
| `Account.sol:389-403` | `verifyDisputeProofHanko` — routes dispute proof through the grace path. |
| `Account.sol:1062-1064` | dispute start — inline `verifyHankoSignature`, requires only `recovered == counterentity`. |

### 6.2 Runtime layer (`runtime/`)

`verifyHankoForHash` (`runtime/hanko/signing.ts:506`) defaults to
`authority?.allowPreviousBoard !== false` — i.e. **default-accept** the previous
board. Every dispute-evidence path omits the override:

| Location | Path | Overrides `allowPreviousBoard`? |
|---|---|---|
| `runtime/entity/tx/handlers/dispute/start-hanko.ts:48` | dispute start | No |
| `runtime/account/tx/handlers/settle-transition.ts:383` | post-settlement proof | No |
| `runtime/account/tx/handlers/settle-transition.ts:404` | non-executor settlement seal | No |
| `runtime/account/consensus/incoming-preflight.ts:51` | account frame preflight | No |
| `runtime/account/consensus/ack-commit.ts:100` | ACK commit | No |
| `runtime/account/consensus/index.ts:893` | ACK-bundled dispute seal | No (defaults true) |
| `runtime/account/consensus/index.ts:940` | standalone dispute input | No (defaults true) |
| `runtime/account/consensus/index.ts:973` | proposal-bundled dispute seal | No (defaults true) |
| `runtime/entity/consensus/output-certification.ts:564,647` | certified entity output | No |
| `runtime/entity/profile-signing.ts:73,154` | profile certification | No |
| `runtime/entity/tx/handlers/settle.ts:506` | settlement hanko | No |
| `runtime/entity/account-counterparty-route.ts:35-47` | counterparty route | **Hardwired** — no switch at all |

The **only** production site that disables it is
`runtime/account/consensus/board-reseal.ts:136` (`allowPreviousBoard: false`),
and only for its frame witness. No dispute-related path disables it.

---

## 7. Cryptographic remediation sketch (for owner review — NOT applied)

The fix must let genuinely historical evidence through while rejecting
post-rotation forgeries. Three options, in increasing strength:

### Option 1 — Anchor the signed payload to the board generation (strongest)

Add a `boardEpoch` (the per-entity counter already tracked in
`EntityProvider.boardEpochs`) to `encodeDisputeProof`. The verifier then accepts
a previous-board signature only when the `boardEpoch` inside the signed message
is `< current`. A proof with the current epoch signed by the previous board is
impossible (the previous board cannot produce a valid signature over an epoch it
predates), and a proof with an old epoch but a nonce/body invented after
rotation is bound to that old epoch — so the contract can apply
epoch-appropriate policy.

Tradeoff: changes the signed digest format → requires an offline migration of
in-flight signatures or a loud rejection during the cutover.

### Option 2 — Reject previous-board authority for dispute STARTS (narrow, lower risk)

Keep the grace window only for **finalization of disputes whose
`initialProofbodyHash` was committed before activation** (case (a)), and require
`verifyCurrentHankoSignature` (current-only) for dispute **starts**
(`Account.sol:1062` and `runtime/.../start-hanko.ts:48`). This blocks ATTACK A
outright and limits ATTACK B to disputes that were already legitimately open.

Tradeoff: an entity that rotates *while* it is about to open a dispute must
re-sign with the new board. Acceptable in practice (rotation is rare and
deliberate).

### Option 3 — Runtime hygiene (defense-in-depth, not sufficient alone)

Flip the runtime default: `verifyHankoForHash` should require
`allowPreviousBoard: true` **explicitly** at each historical-evidence boundary,
defaulting to current-only everywhere else. Mirror the contract's
`verifyCurrentHankoSignature` as the default and opt into grace narrowly.

Tradeoff: none cryptographically; purely a hygiene pass. Does not fix the
contract layer on its own.

**Recommended combination:** Option 2 (contract, blocks the most dangerous
fresh-start path with minimal disruption) + Option 3 (runtime, removes the
default-accept footgun). Option 1 is the principled long-term fix but carries
migration cost and changes dispute-continuity semantics — it needs an explicit
owner decision per `AGENTS.md` (single canonical production path, no
compatibility window without approval).

### Required regression test (whichever option is chosen)

Add a test that signs a dispute proof with the **old key after activation** and
asserts it is **rejected**. The current PoC file can be inverted to serve as
that regression test once the fix lands.

---

## 8. References

- `jurisdictions/contracts/HankoEncoding.sol:36` — `encodeDisputeProof` (no anchor).
- `jurisdictions/contracts/HankoVerifier.sol:234` — `_boardMatches` (timestamp-only grace gate).
- `jurisdictions/contracts/EntityProvider.sol:656` — `verifyHankoSignature` (`currentOnly=false`).
- `jurisdictions/contracts/Account.sol:389` — `verifyDisputeProofHanko` (grace path).
- `jurisdictions/contracts/Account.sol:1062` — dispute start inline verification.
- `runtime/hanko/signing.ts:506` — `verifyHankoForHash` (default-accept previous board).
- `runtime/account/consensus/board-reseal.ts:136` — the only production `allowPreviousBoard:false`.
- `jurisdictions/test/BoardRotationGrace.test.ts:355` — existing test that asserts the attack succeeds (as intended).
- `jurisdictions/test/H01-PreviousBoardGraceExploit.test.ts` — this report's PoC.
