# HTLC and Multi-Hop Payment Protocol

## 1. Data Structures

### 1.1 HTLC Lock (A-Layer)

Each conditional payment is represented by an `HtlcLock` stored in the bilateral `AccountMachine.locks` map, keyed by `lockId`:

| Field               | Type     | Description |
|---------------------|----------|-------------|
| `lockId`            | string   | Deterministic ID: `keccak256(hashlock ‖ height ‖ nonce ‖ timestamp)` |
| `hashlock`          | bytes32  | `keccak256(abi.encode(secret))` where `secret` is a 32-byte preimage |
| `timelock`          | bigint   | Absolute expiry timestamp (unix-ms) |
| `revealBeforeHeight`| number   | J-block height deadline (on-chain enforceable) |
| `amount`            | bigint   | Locked token quantity |
| `tokenId`           | number   | Token identifier |
| `senderIsLeft`      | boolean  | Canonical direction (left = lexicographically smaller entityId) |
| `createdHeight`     | number   | AccountFrame height at creation |
| `envelope`          | HtlcEnvelope &#124; string | Onion routing envelope (encrypted or cleartext) |

### 1.2 Delta Hold Mechanism

The per-token `Delta` structure carries HTLC hold fields that reserve capacity:

```
Delta {
  collateral, ondelta, offdelta,
  leftCreditLimit, rightCreditLimit,
  leftHtlcHold,   // capacity reserved by left's outgoing HTLCs
  rightHtlcHold    // capacity reserved by right's outgoing HTLCs
}
```

`deriveDelta()` deducts holds from available capacity: `outCapacity = max(0, rawOutCapacity - ownHtlcHold - ownSwapHold - ownSettleHold)`. This prevents double-spend: a sender cannot over-commit channel capacity across concurrent HTLCs.

### 1.3 Routing Context (E-Layer)

Each entity maintains `EntityState.htlcRoutes: Map<hashlock, HtlcRoute>` for multi-hop coordination:

| Field              | Type   | Description |
|--------------------|--------|-------------|
| `inboundEntity`    | string | Upstream entity that sent us the HTLC |
| `inboundLockId`    | string | Lock ID on the inbound account |
| `outboundEntity`   | string | Downstream entity we forwarded to |
| `outboundLockId`   | string | Lock ID on the outbound account |
| `pendingFee`       | bigint | Fee to accrue on successful reveal (not on forward) |
| `secret`           | string | Populated when secret is learned |

### 1.4 LockBook (E-Layer Aggregated View)

`EntityState.lockBook: Map<lockId, LockBookEntry>` provides entity-level visibility across all bilateral accounts, recording direction (`outgoing`/`incoming`), amount, hashlock, and timelock.

### 1.5 Onion Envelope

Privacy-preserving routing uses layered encryption. Each `HtlcEnvelope` contains:

- **Intermediary:** `{ nextHop, innerEnvelope }` where `innerEnvelope` is encrypted for the next hop.
- **Final recipient:** `{ finalRecipient: true, secret }` containing the preimage.

Construction proceeds innermost-outward: encrypt Bob's `{finalRecipient, secret}` with Bob's RSA-OAEP key, wrap in Hub's layer with `{nextHop: Bob, innerEnvelope: <encrypted>}`, encrypt for Hub. Sender retains the outermost plaintext wrapper pointing to the first hop.

## 2. Fee Structure

Fees use micro-basis-points (ubp), where 1 ubp = 1/10,000,000:

```
fee = BASE_FEE_USD + (amount * FEE_RATE_UBP) / FEE_DENOMINATOR
    = 0 + (amount * 100) / 10,000,000
```

At the default rate of 100 ubp (= 1 basis point), a $10,000 payment incurs a $0.10 fee. Fees are deducted at each intermediary hop: the forwarded amount equals `amount - fee`. Fees are not immediately credited; they accrue to `EntityState.htlcFeesEarned` only upon successful secret reveal, preventing fee theft on failed payments.

## 3. Timelock Cascade (Griefing Protection)

Timelocks decrease along the route to prevent the upstream-griefing attack (a variant of the Sprite/Blitz attack pattern where an intermediary learns the secret but delays propagation):

```
For route [Alice, Hub, Bob] with baseTimelock T and baseHeight H:

Alice:  timelock = T,                    revealBeforeHeight = H + 3
Hub:    timelock = T - 10s,              revealBeforeHeight = H + 2
Bob:    timelock = T - 20s,              revealBeforeHeight = H + 1
```

General formula: `hopTimelock = baseTimelock - (totalHops - hopIndex - 1) * MIN_TIMELOCK_DELTA_MS` and `hopHeight = baseHeight + (totalHops - hopIndex)`. The sender (Alice) has the longest deadline; the final recipient (Bob) has the shortest. This ensures that if Bob reveals the secret, each upstream hop has strictly more time to propagate it backward before their own lock expires.

Constants: `MIN_TIMELOCK_DELTA_MS = 10,000ms` per hop, `MIN_FORWARD_TIMELOCK_MS = 20,000ms` minimum at first hop.

## 4. Multi-Hop Payment Flow

### 4.1 Lock Phase (Forward: Alice -> Hub -> Bob)

```
Alice                    Hub                      Bob
  |                       |                        |
  |  1. htlcPayment tx   |                        |
  |  (E-layer entity tx)  |                        |
  |                       |                        |
  |  2. Create onion:     |                        |
  |     outer={nextHop:Hub, inner=Enc_Hub(...)}    |
  |     Enc_Hub={nextHop:Bob, inner=Enc_Bob(...)}  |
  |     Enc_Bob={finalRecipient:true, secret}      |
  |                       |                        |
  |  3. htlc_lock(A-layer)|                        |
  |  lockId_AH, H(s), T  |                        |
  |  amount, envelope     |                        |
  |---------------------->|                        |
  |  (bilateral frame     |                        |
  |   consensus: both     |                        |
  |   sign new frame)     |                        |
  |                       |                        |
  |                       | 4. On frame commit:    |
  |                       |    decrypt envelope    |
  |                       |    extract {nextHop:Bob,|
  |                       |     innerEnvelope}     |
  |                       |    deduct fee          |
  |                       |    register htlcRoute  |
  |                       |                        |
  |                       | 5. htlc_lock(A-layer)  |
  |                       |  lockId_HB, H(s), T-10s|
  |                       |  amount-fee, Enc_Bob   |
  |                       |----------------------->|
  |                       |  (bilateral frame      |
  |                       |   consensus)           |
  |                       |                        |
  |                       |                        | 6. On frame commit:
  |                       |                        |    decrypt envelope
  |                       |                        |    sees finalRecipient
  |                       |                        |    extracts secret
```

### 4.2 Settle Phase (Backward: Bob -> Hub -> Alice)

```
Alice                    Hub                      Bob
  |                       |                        |
  |                       |                        | 7. htlc_resolve(A-layer)
  |                       |                        |    outcome='secret'
  |                       |                        |    secret=s
  |                       |<-----------------------|
  |                       |  (bilateral frame      |
  |                       |   consensus: offdelta  |
  |                       |   shifts by +amount)   |
  |                       |                        |
  |                       | 8. Secret propagation: |
  |                       |    lookup htlcRoutes   |
  |                       |    by hashlock         |
  |                       |    accrue fee          |
  |                       |    clean lockBook      |
  |                       |                        |
  | 9. htlc_resolve       |                        |
  |    outcome='secret'   |                        |
  |    secret=s           |                        |
  |<----------------------|                        |
  |  (bilateral frame     |                        |
  |   consensus: offdelta |                        |
  |   shifts by -amount)  |                        |
  |                       |                        |
  | 10. Payment complete  |                        |
  |     (no inbound route |                        |
  |      = we initiated)  |                        |
```

### 4.3 Cancel/Timeout Phase

```
Alice                    Hub                      Bob
  |                       |                        |
  |                       |    [timelock expires]   |
  |                       |                        |
  |                       | htlc_resolve(A-layer)  |
  |                       | outcome='error'        |
  |                       | reason='timeout'       |
  |                       |----------------------->|
  |                       | (hold released, NO     |
  |                       |  offdelta change)      |
  |                       |                        |
  | htlc_resolve          |                        |
  | outcome='error'       |                        |
  | reason='downstream_   |                        |
  |   error'              |                        |
  |<----------------------|                        |
  | (hold released, NO    |                        |
  |  offdelta change)     |                        |
```

Immediate cancellation (before timeout) uses the same `htlc_resolve(outcome='error')` path with reasons like `no_account`, `no_capacity`, `amount_too_small`, or `timelock_too_tight`.

## 5. Delta Mechanics

### 5.1 Lock (htlc_lock)

On lock creation, the sender's hold increases: if `senderIsLeft`, then `delta.leftHtlcHold += amount`. No `offdelta` change occurs -- funds are reserved but not yet transferred. The lock is stored in `accountMachine.locks` and added to the entity-level `lockBook`.

### 5.2 Successful Resolve (outcome='secret')

1. Verify preimage: `keccak256(abi.encode(secret)) == hashlock`
2. Verify not expired: `currentHeight <= revealBeforeHeight AND currentTimestamp <= timelock`
3. Apply canonical delta: `delta.offdelta += senderIsLeft ? -amount : +amount`
4. Release hold: `delta.{left|right}HtlcHold -= amount`
5. Delete lock from `accountMachine.locks`

The offdelta shift represents the actual value transfer. From left's perspective, a negative shift means left paid right (left sent), positive means left received.

### 5.3 Error Resolve (timeout/cancel)

1. For timeout: verify `currentHeight > revealBeforeHeight OR currentTimestamp > timelock`
2. Release hold: `delta.{left|right}HtlcHold -= amount`
3. Delete lock -- NO offdelta change (funds return to sender implicitly via hold release)

## 6. Atomicity Guarantees

Cross-hop atomicity relies on the hashlock binding and the timelock cascade:

1. **Hashlock binding:** All hops use the identical `hashlock = H(secret)`. Knowledge of `secret` is necessary and sufficient to settle any hop. A partial reveal (some hops settled, others not) is safe because each hop is independently bilateral.

2. **Timelock ordering:** Bob's deadline < Hub's deadline < Alice's deadline. If Bob reveals the secret to Hub, Hub has strictly more time to propagate it to Alice. If Hub fails to propagate, Alice's lock eventually times out and her hold is released -- Hub bears the loss (having paid Bob but not received from Alice), creating correct incentive alignment.

3. **No global coordinator:** Each hop settles via independent bilateral consensus. The secret serves as the atomic coordination primitive -- once revealed at any hop, it propagates backward deterministically through the `htlcRoutes` map.

4. **Capacity isolation:** HTLC holds are deducted from available capacity at lock time, preventing concurrent HTLCs from over-committing the channel. Holds are released on both success (with delta shift) and failure (without delta shift).

## 7. Relationship to Bilateral Frame Consensus

HTLC operations (`htlc_lock`, `htlc_resolve`) are `AccountTx` entries within bilateral frames. Both entities in a channel must sign each frame containing HTLC operations, ensuring:

- Both parties agree on the existence and parameters of each lock
- Hold updates are reflected in the signed frame hash
- The `proofBody.htlcLocks[]` array captures active locks for on-chain dispute resolution
- Frame-level validation runs the HTLC handler on a cloned state; commit applies to the real state

HTLC forwarding and secret propagation occur at the E-layer (entity consensus) after A-layer frame commit. The entity processes committed frames, unwraps onion envelopes, and queues new `htlc_lock` or `htlc_resolve` transactions into the appropriate bilateral account's mempool for the next frame proposal cycle.

## 8. Constants

| Parameter                | Value        | Description |
|--------------------------|--------------|-------------|
| `MIN_TIMELOCK_DELTA_MS`  | 10,000 ms    | Per-hop timelock reduction |
| `MIN_FORWARD_TIMELOCK_MS`| 20,000 ms    | Minimum timelock for first hop |
| `MAX_HOPS`               | 20           | Maximum route length |
| `DEFAULT_EXPIRY_MS`      | 30,000 ms    | Baseline HTLC expiry |
| `FEE_RATE_UBP`           | 100          | 1 basis point per hop |
| `FEE_DENOMINATOR`        | 10,000,000   | Micro-basis-point denominator |
| `BASE_FEE_USD`           | 0            | No flat base fee |
| `MAX_PAYMENT_AMOUNT`     | 2^128 - 1    | Upper bound (U128) |
| `MAX_ROUTE_HOPS`         | 10           | Financial limit on route length |
