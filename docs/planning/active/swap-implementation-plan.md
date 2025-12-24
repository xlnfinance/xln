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

### Account Layer (runtime/types.ts)

```typescript
interface SwapOffer {
  offerId: string;           // UUID, not array index
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;        // at this ratio
  minFillBps: number;        // 0-10000, minimum partial fill (basis points)
  expiresAtHeight: number;   // auto-cancel, prevents state bloat
  makerIsLeft: boolean;
}

interface SwapFill {
  offerId: string;
  fillBps: number;           // 0-10000 (basis points, not float!)
}

// AccountMachine additions
interface AccountMachine {
  // ... existing fields
  offers: Map<string, SwapOffer>;
  leftOfferHold: bigint;     // capacity locked for offers
  rightOfferHold: bigint;
}
```

### Entity Layer (runtime/entity-extensions/orderbook.ts)

```typescript
interface OrderbookExtension {
  name: 'orderbook';
  books: Map<string, BookState>;  // "ETH/USDC" -> order book

  // Called when account emits swap_offer
  onSwapOffer(accountId: string, offer: SwapOffer): void;

  // Called on tick - match and generate fills
  onTick(height: number): EntityTx[];
}
```

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

#### Step 3.1: Cross-J Swap Flow

```
1. Alice wants: Sell 2 ETH (Ethereum) for 6000 USDC (Arbitrum)

2. Setup phase:
   - A-H Ethereum account: Alice creates swap_offer for 2 ETH
   - A-H Arbitrum account: Hub creates conditional_receive for 6000 USDC
   - Both reference same swapId + HashLadder commitment

3. Fill phase:
   - Hub decides to fill 75% (7500 bps)
   - Hub reveals HashLadder proof for 7500
   - Both accounts verify and apply partial fill

4. Settlement:
   - Ethereum: Alice sends 1.5 ETH to Hub
   - Arbitrum: Hub sends 4500 USDC to Alice
```

#### Step 3.2: Scenario - scenarios/swap-cross-j.ts

```typescript
// Setup: A-H accounts on both Ethereum and Arbitrum

// Step 1: Alice initiates cross-J swap
const swapId = 'cross-1';
const [secretHigh, secretLow] = [randomBytes(32), randomBytes(32)];
const ratioLadder = createRatioLadder(secretHigh, secretLow);

// On Ethereum account
await aliceHubEth.addAccountTx({
  type: 'cross_swap_offer',
  data: {
    swapId,
    giveTokenId: ETH,
    giveAmount: 2n * 10n**18n,
    ratioLadderHigh: ratioLadder.ladderHigh.target,
    ratioLadderLow: ratioLadder.ladderLow.target,
  }
});

// On Arbitrum account (Hub commits to receive)
await hubAliceArb.addAccountTx({
  type: 'cross_swap_commit',
  data: {
    swapId,
    receiveTokenId: USDC,
    receiveAmount: 6000n * 10n**6n,
    ratioLadderHigh: ratioLadder.ladderHigh.target,
    ratioLadderLow: ratioLadder.ladderLow.target,
  }
});

// Step 2: Hub fills 75%
const proof = signalRatio(7500, [secretHigh, secretLow]);

// Both accounts receive the proof and verify
await aliceHubEth.addAccountTx({
  type: 'cross_swap_fill',
  data: { swapId, ...proof }
});
await hubAliceArb.addAccountTx({
  type: 'cross_swap_fill',
  data: { swapId, ...proof }
});

// Assert: 1.5 ETH moved on Ethereum
// Assert: 4500 USDC moved on Arbitrum
```

## Testing Checklist

### Phase 1: Bilateral
- [ ] swap_offer creates offer, locks capacity
- [ ] swap_offer rejects if insufficient capacity
- [ ] swap_offer rejects duplicate offerId
- [ ] swap_fill works for 100% fill
- [ ] swap_fill works for partial fill (respects minFillBps)
- [ ] swap_fill rejects below minFillBps
- [ ] swap_fill updates deltas atomically
- [ ] swap_cancel releases hold
- [ ] Expired offers auto-cancel (or reject fills)

### Phase 2: Orderbook
- [ ] Extension ingests offers from multiple accounts
- [ ] Price-time priority matching
- [ ] Partial fills propagate correctly
- [ ] Hub can be market maker (own inventory)

### Phase 3: Cross-J
- [ ] HashLadder creation and verification
- [ ] Ratio encoding/decoding (basis points)
- [ ] Cross-account swap coordination
- [ ] Dispute resolution (reveal ladder on-chain)

## References

- [PayWord and MicroMint (Rivest & Shamir, 1996)](https://people.csail.mit.edu/rivest/pubs/RS96a.pdf) - Hash chain micropayments
- 2024 XLN: `.archive/2024_src/app/Transition.ts` - AddSwap/SettleSwap
- 2024 XLN: `.archive/2024_src/test/swap.test.tts` - Original swap tests
