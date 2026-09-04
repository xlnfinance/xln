# consensus invariants

critical rules for bilateral consensus correctness. update this when bugs are found.

## byLeft pattern (channel.ts block.isLeft)

**rule:** handler effects MUST use `byLeft` (frame-level, same on both sides), NEVER perspective-dependent `isOurFrame`.

**why:** `isOurFrame` is true for proposer, false for receiver. the derivation `proposerIsLeft = isOurFrame ? iAmLeft : !iAmLeft` depends on `proofHeader.fromEntity` which is perspective-dependent and can be stale (LevelDB persistence across sessions). `byLeft` is a frame property — identical on both sides by construction.

**channel.ts reference:** `Transition.ts:358-362` — `SetCreditLimit.apply()` uses `block.isLeft` directly. both proposer and receiver call `applyBlock(block, ...)` with the same block object. no perspective concept.

**affected handlers (all use `byLeft` directly):**
- `set_credit_limit`: `side = byLeft ? 'right' : 'left'`
- `htlc_lock`: `senderIsLeft = byLeft`
- `swap_offer`: `makerIsLeft = byLeft`
- `swap_cancel`: `callerIsLeft = byLeft`
- `swap_resolve`: `callerIsLeft = byLeft`
- `j_event_claim`: `claimIsFromLeft = byLeft`

**cosmetic-only perspective:** `direct_payment` may derive `isOurFrame = (byLeft === iAmLeft)` locally for event labels ("Sent" vs "Received"). this is NOT consensus-critical.

**bug caught 2026-02-05:** server had stale `proofHeader.fromEntity` from previous session. credit limit applied to wrong side, causing "Bilateral state injection detected" error on Frame 2 consensus.

## openAccount notification

**rule:** `openAccount` MUST include `creditAmount` (even `0n`) to trigger counterparty notification.

**why:** the handler checks `if (creditAmount !== undefined)` to decide whether to send openAccount to counterparty. without it, only local account is created — counterparty never learns about the channel.

**bug caught 2026-02-05:** scenario openAccount without creditAmount → Hub never created its side → assertion failed on bidirectional check.

## frame processing pipeline

```
processAccountTx(accountMachine, tx, byLeft, timestamp, height, isValidation)
```

4 call sites in `account-consensus.ts`:
1. **proposer validation** (clone): `byLeft = leftEntity === fromEntity`
2. **proposer commit** (real): `byLeft = pendingFrame.byLeft!`
3. **receiver validation** (clone): `byLeft = receivedFrame.byLeft!`
4. **receiver commit** (real): `byLeft = receivedFrame.byLeft!`

## delta semantics

- positive offdelta = RIGHT owes LEFT
- negative offdelta = LEFT owes RIGHT
- LEFT pays -> offdelta DECREASES
- RIGHT pays -> offdelta INCREASES
- LEFT proposer -> sets rightCreditLimit (extending credit TO right)
- RIGHT proposer -> sets leftCreditLimit (extending credit TO left)

## stale state risk

`proofHeader.fromEntity` is perspective-dependent and persists in LevelDB. when account is loaded from DB, this field reflects the LAST entity that wrote it, which may not match current processing context. never derive canonical direction from it alone — always use frame-level `byLeft`.

## cross-j hash-ladder canon (owner decision 2026-08-07)

**rule:** the hash-ladder is the SINGLE settlement authority for a cross-j
order, on BOTH jurisdictions. There are no signed fill receipts and none may
be added: a Hanko-signed receipt path was explicitly rejected because ladder
reveals are far cheaper in gas, and two authorities is how conservation broke.

**rule:** off-chain fill progress is Hub-internal and INFORMATIONAL only —
one uint16 ratio per order carried between the book owner and the source Hub
(`crossJurisdictionFillNotice`), never an Account transaction and never signed
by a user. It is bookkeeping, never authorization, and must never gate a close
or a dispute; users learn the outcome from the pull close. Revealing ladder secrets off-chain is forbidden: the ladder
is single-shot, an escaped secret is spent forever.

**rule:** ladder secrets are revealed in exactly two places:
1. **swap close** — only when the user tells the hub "close at my current fill,
   don't wait", or when the fill reaches 100%;
2. **dispute** — the on-chain reveal, verified against `partialRoot`, governs
   both jurisdictions symmetrically.

**why:** the source chain finalizes whatever ratio the reveal proves. If the
target side filters that reveal through local informational state (the old
`exceeds committed fill` veto in salvage, or the `hasCrossJurisdictionCommittedFill`
dispute-candidate filter), the two jurisdictions settle different ratios and
cross-j conservation breaks — by the guard, not by the reveal. A verified
reveal above the last informational update is NORMAL: the hub's actual fill
legally runs ahead of its last "matched X%" message.

**bug caught 2026-08-06:** dispute salvage rejected a cryptographically
verified reveal because it exceeded the informational ratio; source J had
already paid the full revealed amount while target recovery refused to mirror
it (audit P1-2). Both gates removed; the reveal is the truth.
