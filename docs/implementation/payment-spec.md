# Payment and HTLC flow

**Role:** live implementation guide  
**Audience:** protocol implementers and auditors  
**Authority:** executable types and reducers; this guide explains their ordering

This document traces value through the nested Runtime → Entity → Account
cascade. Read [the cascade architecture](../core/rjea-architecture.md) first.

## Invariants

1. Money changes only in the Account reducer.
2. Entity authorizes intent, chooses the Account, and routes committed child
   outputs. It does not edit Account balances.
3. Runtime owns ingress, persistence, and external delivery. It exposes a new
   frame only after the WAL commit.
4. Reducers read deterministic State and Inputs. RPC, contracts, transports,
   private keys, and wall-clock time are never reducer authority.
5. Each peer independently derives and verifies the same Account state root.

## The common path

```text
user / peer / J watcher
  │
  ▼
RuntimeInput
  ├─ RuntimeTx[]
  └─ routed EntityInput[]
        │
        ▼
      EntityInput
        ├─ EntityTx[]
        └─ Entity consensus evidence
              │
              ▼
            AccountInput
              ├─ txs(AccountTx[])       local future-frame admission
              └─ AccountPeerInput       signed bilateral evidence
                    │
                    ▼
                 AccountFrame
                    │ bilateral ACK
                    ▼
                 EntityOutput
                    │
                    ▼
RuntimeFrame → WAL → external delivery
```

An `EntityTx` is not an `AccountTx`. It may deterministically produce a local
`AccountInput { kind: 'txs' }`, or it may carry one exact peer
`AccountPeerInput` as `EntityTx.accountInput`. Both branches enter
`applyAccountInput`; neither bypasses the Account machine.

## Direct payment

`directPayment` is the immediate, non-conditional operation for a trusted
delivery route. The wallet emits it only when the user explicitly selects
trusted delivery and the route has a recipient gateway:

```typescript
type DirectPaymentIntent = Extract<EntityTx, { type: 'directPayment' }>;
```

The Entity handler validates the route and converts the next hop into an
Account-owned `direct_payment` transaction. The Account reducer:

1. resolves the canonical LEFT/RIGHT perspective;
2. derives available capacity with the single canonical `deriveDelta`;
3. rejects insufficient capacity before mutation;
4. moves the signed amount in the Account delta;
5. records the transaction in the proposed Account frame.

The counterparty replays those exact transactions against its matching
committed Account state. It ACKs only the byte-identical frame and state root.
Forwarding to a later hop is created from the committed child frame, never from
an uncommitted proposal.

```text
source Entity
  └─ Account(source, hop 1)
       └─ committed forward
            └─ hop 1 Entity
                 └─ Account(hop 1, hop 2)
                      └─ ...
```

## Canonical payment operations

- Trusted immediate payments use `directPayment`, which creates Account `direct_payment`.
- Trustless `instant` and `async` payments use `htlcPayment`, which creates Account `htlc_lock` along a prepared encrypted route.
- Same-jurisdiction swaps use `placeSwapOffer`, which creates Account
  `swap_offer`; canonical matching commits Account `swap_resolve` fills. There
  is no separate public hashlock-swap transaction.
- Cross-jurisdiction swaps use `prepareCrossJurisdictionSwap`, followed by
  proposer materialization and one `registerCrossJurisdictionSwap` at each
  hub. Those registrations create the exact source and target Account
  `cross_pull_lock` legs together. The exact paired Runtime cohort is the only
  opening path, and `cross_pull_close` is the only terminal path; there is no
  generic pull product or public raw pull Entity command.
- Bilateral credit uses `extendCredit`, which creates the Account `set_credit_limit`.
- Lending positions use exactly four public Entity operations:
  `lendingOffer → lending_fund`, `lendingBorrow → lending_borrow_request`,
  `lendingRepay → lending_repay`, and
  `lendingClosePosition → lending_close_request`. Account follow-ups grant or
  revoke loan credit and pay out a closed lender position only after the
  corresponding bilateral commit.

Cross-jurisdiction swaps never enter the user-payment handler. Their source and
target legs bind the order, route, jurisdiction evidence, and hash ladder in
the Account state where settlement is enforced.

Each hop commits an `htlc_lock` Account transaction containing:

- a unique lock id;
- the shared hashlock;
- token and amount;
- the Account deadline;
- the next encrypted envelope or final recipient offer.

The lock immediately reduces spendable capacity through Account holds. No
separate balance cache is authoritative.

### Successful reveal

```text
1. User commits a lock toward H1.
2. H1 commits the next lock toward H2.
3. H2 commits the final lock toward the recipient.
4. Recipient returns the secret through its Account with H2.
5. H2 resolves backward through its Account with H1.
6. H1 resolves backward through its Account with the user.
```

Every unlock is an `htlc_resolve` inside a committed bilateral Account frame.
A self-payment follows the same six logical edges; co-located Runtime replicas
may deliver them quickly, but may not skip certification or WAL visibility.

The raw secret is not guessed, polled, or read from a contract. It becomes
usable only after the exact encrypted offer and Account acknowledgement make
the reveal deterministic.

### Failure and timeout

Deadlines are frame/J-height data, not local timers. A timeout transaction may
release a lock only when the committed deterministic height permits it.
Transport retries resend the exact signed input; they never create a new
proposal with a different payload.

## Bilateral proposal collision

Account proposals do not expire locally. Once a Hanko leaves a replica, that
proposal is final and is resent unchanged until the protocol advances.

Both peers may propose the same next height. The lower Entity id is canonical
LEFT, and the valid LEFT frame wins the collision at equal height. RIGHT:

1. restores the last committed Account state;
2. accepts LEFT's frame as the winning next frame;
3. restores its losing transactions to the mempool in original order;
4. reapplies them above the accepted frame.

This is not a timeout, leader election, or retry heuristic. It matches the
unconditional LEFT tie-break enforced by the jurisdiction contract, so the
off-chain winner is also the dispute winner.

## Jurisdiction boundary

Account settlement and dispute requests become deterministic outputs. Runtime
submits them after its enclosing frame is durable. The reducer never reads a
live contract nonce or balance.

Finalized contract evidence follows one canonical path:

```text
transport log
  → JEventIngress
  → JEvent
  → JurisdictionEvent
  → certified JurisdictionEventBlock
  → RuntimeInput
  → EntityTx
  → AccountTx
```

Authenticated events update Account jurisdiction state, including collateral,
settlement, dispute, and nonce facts. Malformed financial evidence fails loud
in development and tests. Production drops malformed uncommitted ingress; it
does not publish it in a Runtime frame.

## Rebalance

Rebalance is an Account protocol, not a faucet side effect:

1. a user commits `request_collateral` with the exact fee-policy version;
2. the Hub waits until the committed request reaches its soft limit;
3. the Hub constructs one atomic jurisdiction batch;
4. finalized jurisdiction events update both Account replicas;
5. a rejected or expired request returns its prepaid fee through an explicit
   Account transaction.

A request is never silently topped up or inferred from a live contract read.
Missing fee state rejects the batch before any reserve or Account mutation.

## Source reading order

1. `runtime/types/entity-tx.ts` — user and peer Entity intents.
2. `runtime/types/account.ts` — Account Input, Tx, Frame, State, and Replica.
3. `runtime/entity/tx/handlers/payments/direct-payment.ts` — direct intent routing.
4. `runtime/entity/tx/handlers/htlc/payment.ts` — prepared onion admission.
5. `runtime/account/consensus/index.ts` — the single Account input boundary.
6. `runtime/account/tx/apply.ts` — validation dispatch.
7. `runtime/account/tx/mutation.ts` — Account-owned mutation dispatch.
8. `runtime/account/consensus/` — proposal, ACK, collision, and commit.
9. `runtime/runtime/frame/` — enclosing Runtime frame and WAL boundary.

For executable evidence, start with:

- `runtime/__tests__/derive-delta-property.test.ts`;
- `runtime/__tests__/account/consensus/account-frame-integrity.test.ts`;
- `runtime/scripts/operations/persistence/persistence-simultaneous-proposal-smoke.ts`;
- `runtime/__tests__/runtime-frame-atomicity.test.ts`;
- the focused HTLC and self-payment E2E scenarios.
