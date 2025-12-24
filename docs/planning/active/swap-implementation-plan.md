# Swap Implementation Plan

## Overview

Bilateral swaps are the killer feature of XLN - instant, free token exchanges between counterparties. This is how centralized exchanges (Binance, Coinbase) work, but with cryptographic proofs and chain-exitability.

**Key insight:** Swaps without orderbooks are useless. Alice never trades directly with Bob - there's always a Hub in between that matches orders.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Hub Entity                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              OrderbookExtension (pluggable)             ││
│  │   ETH/USDC: [bid: 2999, ask: 3001, ...]                ││
│  │                                                         ││
│  │   ingress: swap_offer from accounts                     ││
│  │   match: deterministic SoA engine                       ││
│  │   egress: swap_fill pushed to accounts                  ││
│  └─────────────────────────────────────────────────────────┘│
│                          ↕                                   │
│  ┌──────────────┐    ┌──────────────┐                       │
│  │ A-H Account  │    │ H-B Account  │                       │
│  │ offers: Map  │    │ offers: Map  │                       │
│  └──────────────┘    └──────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

**Layer separation:**
- `AccountMachine.offers` - bilateral swap offers (consensus state)
- `OrderbookExtension` - hub's matching logic (entity business logic)
- LOB engine executes deterministically for multi-signer consensus

## Data Structures

### Fill Ratio: uint16 (0-65535), NOT bps

We use full uint16 range for maximum granularity:
- `0` = 0% fill
- `65535` = 100% fill
- `32768` = ~50% fill

This is more granular than bps (0-10000) and matches HashLadder's 2x8-bit encoding.

### Canonical Pair Ordering (Codex fix)

To prevent buy/sell orders going into different books:
```typescript
// Always normalize: base = min(tokenA, tokenB), quote = max
const { base, quote, pairId } = canonicalPair(tokenA, tokenB);
// pairId = "1/2" for tokens 1 and 2

// Derive side from which token you're giving
const side = deriveSide(giveTokenId, wantTokenId);
// Giving base (lower id) = SELL, Giving quote (higher id) = BUY
```

### Account Layer (runtime/types.ts)

```typescript
interface SwapOffer {
  offerId: string;           // UUID, not array index
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;        // at this ratio
  minFillRatio: number;      // 0-65535 (uint16), minimum partial fill
  expiresAtHeight: number;   // auto-cancel, prevents state bloat
  makerIsLeft: boolean;
}

// AccountMachine additions
interface AccountMachine {
  // ... existing fields
  swapOffers: Map<string, SwapOffer>;  // bilateral swap offers
  leftSwapHold: bigint;      // capacity locked for offers (added to deriveDelta)
  rightSwapHold: bigint;
}
```

### Account Transactions

**User can:**
- `swap_offer` - Create limit order (locks capacity)
- `swap_cancel` - Request cancellation

**Hub (counterparty) can:**
- `swap_resolve` - Fill 0-100% AND optionally cancel remainder (merged tx)

```typescript
type AccountTx =
  | { type: 'swap_offer'; data: SwapOfferData }
  | { type: 'swap_cancel'; data: { offerId: string } }
  | { type: 'swap_resolve'; data: SwapResolveData };  // Hub only

interface SwapOfferData {
  offerId: string;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  minFillRatio: number;      // 0-65535
  expiresAtHeight: number;
}

interface SwapResolveData {
  offerId: string;
  fillRatio: number;         // 0-65535 (uint16)
  cancelRemainder: boolean;  // true = fill + cancel, false = fill + keep open
}
```

### Entity Layer (runtime/orderbook/)

Already implemented in `runtime/orderbook/`:
- `types.ts` - canonicalPair, deriveSide, Side, TIF
- `engine.ts` - O(1) matching, bitmap best-price
- `manager.ts` - multi-book lifecycle, offer ingestion

## Implementation Steps

### Phase 1: Bilateral Swaps (Alice ↔ Hub)

**Goal:** Alice can place limit orders with Hub, Hub can fill them.

#### Step 1.1: Account Layer Handlers

Create handlers following HTLC pattern:

```
runtime/account-tx/handlers/
├── swap-offer.ts    # Create offer, lock capacity
├── swap-fill.ts     # Fill offer (partial ok), update deltas
└── swap-cancel.ts   # Remove offer, release capacity
```

**swap-offer.ts:**
- Validate offerId uniqueness
- Validate giveAmount > 0, wantAmount > 0
- Check capacity (including existing holds)
- Lock capacity: `delta.leftOfferHold += giveAmount`
- Store in `offers: Map`

**swap-fill.ts:**
- Find offer by offerId
- Validate fillBps >= offer.minFillBps
- Calculate amounts: `filledGive = (giveAmount * fillBps) / 10000n`
- Update deltas atomically:
  - Maker gives: `delta.offdelta -= filledGive` (if makerIsLeft)
  - Maker receives: other delta increases
- Release hold proportionally
- Remove offer if fully filled, update if partial

**swap-cancel.ts:**
- Find offer, validate ownership
- Release hold
- Remove from offers Map

#### Step 1.2: Scenario - scenarios/swap-bilateral.ts

```typescript
// Step 1: Setup A-H account with two tokens (ETH=1, USDC=2)
// Alice has 10 ETH capacity, Hub has 30000 USDC capacity

// Step 2: Alice places limit order
// "Sell 2 ETH for 6000 USDC" (price: 3000 USDC/ETH)
await aliceHub.addAccountTx({
  type: 'swap_offer',
  data: {
    offerId: 'order-1',
    giveTokenId: 1,      // ETH
    giveAmount: 2n * 10n**18n,
    wantTokenId: 2,      // USDC
    wantAmount: 6000n * 10n**6n,
    minFillBps: 5000,    // min 50% fill
    expiresAtHeight: currentHeight + 1000,
  }
});

// Assert: Alice's ETH capacity reduced by hold
// Assert: offer exists in account state

// Step 3: Hub fills 50%
await hubAlice.addAccountTx({
  type: 'swap_fill',
  data: {
    offerId: 'order-1',
    fillBps: 5000,  // 50%
  }
});

// Assert: Alice's ETH delta decreased by 1 ETH
// Assert: Alice's USDC delta increased by 3000 USDC
// Assert: offer still exists with remaining 1 ETH

// Step 4: Hub fills remaining 50%
await hubAlice.addAccountTx({
  type: 'swap_fill',
  data: {
    offerId: 'order-1',
    fillBps: 10000,  // remaining 100% of what's left
  }
});

// Assert: offer removed
// Assert: final deltas correct
```

### Phase 2: Orderbook Matching (A ↔ H ↔ B)

**Goal:** Hub matches Alice's sell with Bob's buy.

#### Step 2.1: OrderbookExtension

```typescript
// runtime/entity-extensions/orderbook.ts

interface AggregatedOrder {
  accountId: string;
  offerId: string;
  side: 'buy' | 'sell';
  price: bigint;      // in quote token units
  quantity: bigint;   // in base token units
  minFillBps: number;
}

class OrderbookExtension implements EntityExtension {
  books: Map<string, AggregatedOrder[]> = new Map();

  // Called when we receive swap_offer from an account
  ingestOffer(accountId: string, offer: SwapOffer): void {
    const pair = `${offer.giveTokenId}/${offer.wantTokenId}`;
    const price = (offer.wantAmount * 10n**18n) / offer.giveAmount;

    this.books.get(pair)?.push({
      accountId,
      offerId: offer.offerId,
      side: 'sell',  // giving base, wanting quote
      price,
      quantity: offer.giveAmount,
      minFillBps: offer.minFillBps,
    });

    this.sortBook(pair);
  }

  // Match crossing orders, return fills to push
  match(pair: string): SwapFillTx[] {
    const book = this.books.get(pair);
    const fills: SwapFillTx[] = [];

    // Price-time priority matching
    // ... standard LOB matching logic

    return fills;
  }
}
```

#### Step 2.2: Scenario - scenarios/swap-orderbook.ts

```typescript
// Setup: A-H and H-B accounts, both with ETH and USDC

// Step 1: Alice places sell order
// "Sell 2 ETH @ 3000 USDC"
await aliceHub.placeOrder({ side: 'sell', price: 3000, qty: 2 });

// Step 2: Bob places buy order (crosses Alice's price)
// "Buy 1 ETH @ 3010 USDC" (willing to pay more)
await bobHub.placeOrder({ side: 'buy', price: 3010, qty: 1 });

// Step 3: Hub's orderbook extension matches
// - Alice sells 1 ETH to Bob @ 3000 (Alice's price, maker)
// - Hub generates swap_fill for both accounts

// Step 4: Verify
// Alice: -1 ETH, +3000 USDC
// Bob: +1 ETH, -3000 USDC (gets maker price)
// Alice still has 1 ETH sell order open
```

### Phase 3: Cross-Jurisdiction Swaps (HashLadder)

**Goal:** Swap ETH (Ethereum) for USDC (Arbitrum) with partial fills.

#### Why HashLadder?

Same-J swaps don't need it - both tokens in same AccountMachine, atomic update.

Cross-J requires coordination between two separate accounts:
- A-H account on Ethereum (ETH)
- A-H account on Arbitrum (USDC)

HTLCs are binary (0% or 100%). For partial fills, we need to signal a ratio.

#### HashLadder Primitive

Inspired by PayWord (Rivest & Shamir, 1996) - hash chains for micropayments.

**CRITICAL: Taker-Generated Ladder (Gemini fix)**

The TAKER (filler) generates the HashLadder, not the maker:
- Maker (Alice): Commits to swap terms (ETH/USDC ratio, max amount)
- Taker (Hub): Commits to HashLadder representing 0-100% fill capability
- Execution: Hub reveals preimage for 75% → claims 75% of Alice's ETH
- Atomic: Alice sees preimage → uses it to claim 75% of Hub's USDC on other chain

This makes the swap "Taker-Driven" - the filler holds the option to execute.

```typescript
// runtime/crypto/hash-ladder.ts

interface HashLadder {
  target: string;     // final hash (commitment)
  maxRungs: number;   // e.g., 256 for uint8
}

// To signal value V (0-255):
// Reveal preimage P where hash^V(P) = target
function createLadder(secret: string, maxRungs: number): HashLadder {
  let current = keccak256(secret);
  for (let i = 0; i < maxRungs; i++) {
    current = keccak256(current);
  }
  return { target: current, maxRungs };
}

function verifyLadder(preimage: string, claimedRungs: number, target: string): boolean {
  let current = preimage;
  for (let i = 0; i < claimedRungs; i++) {
    current = keccak256(current);
  }
  return current === target;
}

// For uint16 ratio (0-10000 bps): use 2 ladders
// High byte: 0-100 (percentage)
// Low byte: 0-100 (basis points within percent)
interface RatioLadder {
  ladderHigh: HashLadder;  // 0-100
  ladderLow: HashLadder;   // 0-100
}

function signalRatio(bps: number, secrets: [string, string]): RatioProof {
  const high = Math.floor(bps / 100);  // 0-100
  const low = bps % 100;                // 0-99
  return {
    preimageHigh: computePreimage(secrets[0], high),
    rungsHigh: high,
    preimageLow: computePreimage(secrets[1], low),
    rungsLow: low,
  };
}
```

#### Step 3.1: Cross-J Swap Flow (Taker-Driven)

```
1. Alice wants: Sell 2 ETH (Ethereum) for 6000 USDC (Arbitrum)

2. Setup phase:
   - Alice: Creates swap_offer on A-H Ethereum account (2 ETH, wants 6000 USDC)
   - Hub (TAKER): Generates HashLadder secrets, commits targets to BOTH accounts
   - A-H Ethereum: Alice's offer + Hub's ladder commitment
   - A-H Arbitrum: Hub locks 6000 USDC + same ladder commitment

3. Fill phase (Hub-driven):
   - Hub decides to fill 75% (7500 bps)
   - Hub reveals HashLadder preimages proving 75%
   - Hub claims 1.5 ETH on Ethereum account

4. Settlement (atomic):
   - Alice sees Hub's revealed preimages on Ethereum
   - Alice uses SAME preimages to claim 4500 USDC on Arbitrum
   - Atomicity: Hub can't claim ETH without revealing proof Alice needs
```

#### Step 3.2: Scenario - scenarios/swap-cross-j.ts

```typescript
// Setup: A-H accounts on both Ethereum and Arbitrum

// Step 1: Alice creates cross-J swap offer
const swapId = 'cross-1';

await aliceHubEth.addAccountTx({
  type: 'cross_swap_offer',
  data: {
    swapId,
    giveTokenId: ETH,
    giveAmount: 2n * 10n**18n,
    wantTokenId: USDC,
    wantAmount: 6000n * 10n**6n,
    wantJurisdiction: 'arbitrum',
    expiresAtHeight: currentHeight + 1000,
  }
});

// Step 2: Hub (TAKER) commits HashLadder to both accounts
const [secretHigh, secretLow] = [randomBytes(32), randomBytes(32)];
const ratioLadder = createRatioLadder(secretHigh, secretLow);

// Hub commits on Ethereum (where Alice's offer is)
await hubAliceEth.addAccountTx({
  type: 'cross_swap_accept',
  data: {
    swapId,
    ratioLadderHigh: ratioLadder.ladderHigh.target,
    ratioLadderLow: ratioLadder.ladderLow.target,
  }
});

// Hub locks USDC on Arbitrum with same ladder
await hubAliceArb.addAccountTx({
  type: 'cross_swap_lock',
  data: {
    swapId,
    giveTokenId: USDC,
    giveAmount: 6000n * 10n**6n,  // Hub's side
    ratioLadderHigh: ratioLadder.ladderHigh.target,
    ratioLadderLow: ratioLadder.ladderLow.target,
  }
});

// Step 3: Hub fills 75% by revealing preimages
const proof = signalRatio(7500, [secretHigh, secretLow]);

// Hub claims 1.5 ETH on Ethereum
await hubAliceEth.addAccountTx({
  type: 'cross_swap_fill',
  data: { swapId, ...proof }
});

// Step 4: Alice sees proof, claims 4500 USDC on Arbitrum
// (Same preimages work on both chains - atomic!)
await aliceHubArb.addAccountTx({
  type: 'cross_swap_claim',
  data: { swapId, ...proof }  // Alice reuses Hub's revealed preimages
});

// Assert: 1.5 ETH moved on Ethereum (Hub received)
// Assert: 4500 USDC moved on Arbitrum (Alice received)
// Assert: Remaining 0.5 ETH offer still open (or cancelled)
```

## Implementation Notes (Gemini Review)

### Expired Offer Pruning
Offers have `expiresAtHeight` but need explicit cleanup:
- In `swap_fill`: Check expiry before processing, reject if expired
- In account tick/maintenance: Prune expired offers, release holds
- Without pruning, `offers` Map grows indefinitely

### Delta Update Rules (Same as HTLCs)
Canonical direction per token:
- Left gives → delta decreases (negative)
- Right gives → delta increases (positive)

Example: Alice (Left) swaps 1 ETH for 3000 USDC
- ETH Delta: Alice gives → `-1 ETH`
- USDC Delta: Alice receives → `+3000 USDC`

### Race Conditions: Cancel vs Fill
Account layer linearizes (whoever's tx lands first wins), but:
- OrderbookExtension must handle "fill failed, offer gone" gracefully
- Don't crash on stale fills - just skip and log
- Return failure event so extension can update its book state

## Testing Checklist

### Phase 1: Bilateral
- [ ] swap_offer creates offer, locks capacity
- [ ] swap_offer rejects if insufficient capacity
- [ ] swap_offer rejects duplicate offerId
- [ ] swap_fill works for 100% fill
- [ ] swap_fill works for partial fill (respects minFillBps)
- [ ] swap_fill rejects below minFillBps
- [ ] swap_fill updates deltas atomically (both tokens)
- [ ] swap_fill rejects expired offers
- [ ] swap_cancel releases hold
- [ ] Expired offers pruned on tick
- [ ] Race condition: cancel before fill handled gracefully

### Phase 2: Orderbook
- [ ] Extension ingests offers from multiple accounts
- [ ] Price-time priority matching
- [ ] Partial fills propagate correctly
- [ ] Hub can be market maker (own inventory)
- [ ] Failed fills (offer gone) handled gracefully

### Phase 3: Cross-J
- [ ] HashLadder creation and verification
- [ ] Ratio encoding/decoding (basis points)
- [ ] Taker-generated ladder (Hub commits, Hub reveals)
- [ ] Cross-account swap coordination
- [ ] Alice can claim using Hub's revealed preimages
- [ ] Dispute resolution (reveal ladder on-chain)

## References

- [PayWord and MicroMint (Rivest & Shamir, 1996)](https://people.csail.mit.edu/rivest/pubs/RS96a.pdf) - Hash chain micropayments
- 2024 XLN: `.archive/2024_src/app/Transition.ts` - AddSwap/SettleSwap
- 2024 XLN: `.archive/2024_src/test/swap.test.tts` - Original swap tests
