# XLN Payment System Specification
## Version 1.1 - January 2026

**Status:** Phase 1 (Direct Payments) complete. Phases 2-5 (HTLCs, onion routing, pathfinding) in design/partial implementation.

## Architecture Overview

The XLN payment system implements a hierarchical state machine architecture where:
- **Entity Machine (E-Machine)**: Handles entity consensus, proposes blocks, receives payment commands
- **Account Machine (A-Machine)**: Manages bilateral consensus between entity pairs, processes actual payments
- **Server Machine (S-Machine)**: Routes inputs, ticks every 100ms, manages global state

All payments originate as EntityTx in the E-Machine and flow down to the appropriate A-Machines.

## 1. Direct Payment (Without Subcontracts)

### 1.1 Overview
Direct payments transfer value directly between two entities that have an established account relationship. No hashlocks or conditional logic required.

### 1.2 Data Structures

```typescript
// In types.ts - EntityTx for direct payment
interface DirectPaymentEntityTx {
  type: 'direct-payment';
  data: {
    recipientEntityId: string;
    tokenId: number;
    amount: bigint;
    description?: string;
    invoiceId?: string; // For payment tracking
  };
}

// Account-level transaction
interface DirectPaymentAccountTx {
  type: 'direct-payment';
  data: {
    tokenId: number;
    amount: bigint;
    description?: string;
    invoiceId?: string;
    direction: 'outgoing' | 'incoming'; // Set by A-Machine
  };
}
```

### 1.3 Implementation Flow

#### Step 1: Entity Machine Receives Payment Command
```typescript
// In entity-tx/apply.ts
function applyDirectPaymentTx(
  entityState: EntityState,
  tx: DirectPaymentEntityTx,
  signerId: string
): { events: string[]; accountInputs: AccountInput[] } {
  const events: string[] = [];

  // Validate sender has authority
  if (!entityState.signers.includes(signerId)) {
    throw new Error(`Signer ${signerId} not authorized for entity`);
  }

  // Create account input for the recipient
  const accountInput: AccountInput = {
    entityId: entityState.entityId,
    counterpartyEntityId: tx.data.recipientEntityId,
    accountTxs: [{
      type: 'direct-payment',
      data: {
        ...tx.data,
        direction: 'outgoing'
      }
    }],
    timestamp: env.timestamp  // CRITICAL: Use controlled timestamp for determinism
  };

  events.push(`💸 Initiating payment of ${tx.data.amount} token ${tx.data.tokenId} to ${tx.data.recipientEntityId}`);

  return { events, accountInputs: [accountInput] };
}
```

#### Step 2: Entity Consensus Aggregates Account Inputs
```typescript
// In entity-consensus.ts - Modified applyEntityInput
export const applyEntityInput = async (
  env: Env,
  entityReplica: EntityReplica,
  entityInput: EntityInput
): Promise<{ newState: EntityState, outputs: EntityInput[] }> => {
  // ... existing validation ...

  // Process entity transactions
  const proposableAccountMachines: Map<string, AccountInput[]> = new Map();

  for (const tx of entityInput.entityTxs || []) {
    const result = applyEntityTx(entityReplica.state, tx);

    // Aggregate account inputs by counterparty
    for (const accountInput of result.accountInputs || []) {
      const key = accountInput.counterpartyEntityId;
      if (!proposableAccountMachines.has(key)) {
        proposableAccountMachines.set(key, []);
      }
      proposableAccountMachines.get(key)!.push(accountInput);
    }
  }

  // At end of frame processing, propose to all flushable accounts
  for (const [counterpartyId, inputs] of proposableAccountMachines) {
    const accountMachine = env.accountMachines.get(
      `${entityReplica.entityId}:${counterpartyId}`
    );

    if (accountMachine) {
      // Add to mempool
      for (const input of inputs) {
        accountMachine.mempool.push(...input.accountTxs);
      }

      // Propose frame if we're proposer
      if (accountMachine.isProposer) {
        const result = await proposeAccountFrame(accountMachine);
        if (result.success && result.accountInput) {
          // Bubble up account input as entity output
          outputs.push({
            entityId: counterpartyId,
            signerId: entityReplica.signerId,
            accountInputs: [result.accountInput]
          });
        }
      }
    }
  }

  // ... rest of existing code ...
};
```

#### Step 3: Account Machine Processes Payment
```typescript
// In account-consensus.ts - Extended processAccountTx
case 'direct-payment': {
  const { tokenId, amount, description, direction } = accountTx.data;

  // Get or create delta
  let delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    delta = createDefaultDelta(tokenId);
    accountMachine.deltas.set(tokenId, delta);
  }

  // Derive current capacity
  const derived = deriveDelta(delta, accountMachine.isProposer);

  if (direction === 'outgoing') {
    // Check capacity
    if (amount > derived.outCapacity) {
      return {
        success: false,
        error: `Insufficient capacity: ${amount} > ${derived.outCapacity}`,
        events
      };
    }

    // Apply payment
    delta.offdelta += amount;
    events.push(`💸 Sent ${amount} token ${tokenId} to ${accountMachine.counterpartyEntityId}`);
  } else {
    // Incoming payment
    delta.offdelta -= amount;
    events.push(`💰 Received ${amount} token ${tokenId} from ${accountMachine.counterpartyEntityId}`);
  }

  return { success: true, events };
}
```

## 2. Hashlock Payment with Onion Routing

### 2.1 Overview
Hashlock payments enable trustless multi-hop payments through intermediary entities. Uses HTLCs (Hash Time-Locked Contracts) and onion routing for privacy.

### 2.2 Data Structures

```typescript
// Hashlock state in AccountMachine
interface HashlockEntry {
  hash: string;
  amount: bigint;
  tokenId: number;
  timelock: number; // Unix timestamp
  state: 'pending' | 'settled' | 'cancelled';
  routingPacket?: string; // Encrypted onion packet

  // Tracking for multi-hop
  incomingChannelId?: string; // Where we received from
  outgoingChannelId?: string; // Where we forwarded to
}

// Entity-level hashlock payment
interface HashlockPaymentEntityTx {
  type: 'hashlock-payment';
  data: {
    route: string[]; // Entity IDs forming the payment path
    finalRecipient: string;
    tokenId: number;
    amount: bigint;
    description?: string;
  };
}

// Account-level transactions
interface AddHashlockAccountTx {
  type: 'add-hashlock';
  data: {
    hash: string;
    tokenId: number;
    amount: bigint;
    timelock: number;
    routingPacket: string; // Encrypted for next hop
  };
}

interface SettleHashlockAccountTx {
  type: 'settle-hashlock';
  data: {
    hash: string;
    secret: string;
  };
}

interface CancelHashlockAccountTx {
  type: 'cancel-hashlock';
  data: {
    hash: string;
    reason: string;
  };
}
```

### 2.3 Onion Routing Implementation

```typescript
// In entity-tx/onion.ts
import { encrypt, decrypt } from '../crypto-utils';

interface OnionLayer {
  amount: bigint;
  tokenId: number;
  nextHop?: string;
  finalData?: {
    recipient: string;
    description?: string;
    invoiceId?: string;
  };
}

export function createOnionPacket(
  route: string[],
  finalData: any,
  encryptionKeys: Map<string, string>
): string {
  // Start with innermost layer (final recipient)
  let packet = JSON.stringify({
    ...finalData,
    isFinal: true
  });

  // Wrap in encryption layers, reverse order
  for (let i = route.length - 1; i >= 0; i--) {
    const layerData: OnionLayer = {
      amount: finalData.amount,
      tokenId: finalData.tokenId,
      nextHop: i < route.length - 1 ? route[i + 1] : undefined,
      finalData: i === route.length - 1 ? finalData : undefined
    };

    // Encrypt current packet for this hop
    const pubKey = encryptionKeys.get(route[i])!;
    packet = encrypt(pubKey, JSON.stringify({
      ...layerData,
      innerPacket: packet
    }));
  }

  return packet;
}

export function peelOnionLayer(
  encryptedPacket: string,
  privateKey: string
): { data: OnionLayer; nextPacket?: string } {
  const decrypted = decrypt(privateKey, encryptedPacket);
  const parsed = JSON.parse(decrypted);

  return {
    data: {
      amount: parsed.amount,
      tokenId: parsed.tokenId,
      nextHop: parsed.nextHop,
      finalData: parsed.finalData
    },
    nextPacket: parsed.innerPacket
  };
}
```

### 2.4 Hashlock Payment Flow

#### Step 1: E-Machine Initiates Hashlock Payment
```typescript
// In entity-tx/handlers/payment.ts
async function applyHashlockPaymentTx(
  env: Env,
  entityState: EntityState,
  tx: HashlockPaymentEntityTx,
  signerId: string
): Promise<{ events: string[]; accountInputs: AccountInput[] }> {
  // Generate payment secret and hash
  const secret = generateSecret();
  const hash = keccak256(secret);

  // Store secret for later revelation
  env.paymentSecrets.set(hash, {
    secret,
    entityId: entityState.entityId,
    created: env.timestamp  // CRITICAL: Deterministic timestamp
  });

  // Get routing information
  const route = tx.data.route;
  const firstHop = route[0];

  // Create onion packet
  const encryptionKeys = await getEntityEncryptionKeys(route);
  const onionPacket = createOnionPacket(route, {
    ...tx.data,
    secret // Include secret in final layer
  }, encryptionKeys);

  // Create account input for first hop
  const accountInput: AccountInput = {
    entityId: entityState.entityId,
    counterpartyEntityId: firstHop,
    accountTxs: [{
      type: 'add-hashlock',
      data: {
        hash,
        tokenId: tx.data.tokenId,
        amount: tx.data.amount,
        timelock: env.timestamp + (route.length * 60 * 60 * 1000), // 1hr per hop (deterministic)
        routingPacket: onionPacket
      }
    }]
  };

  return {
    events: [`🔒 Initiating hashlock payment via ${route.join(' → ')}`],
    accountInputs: [accountInput]
  };
}
```

#### Step 2: A-Machine Processes Hashlock
```typescript
// In account-consensus.ts - Extended processAccountTx
case 'add-hashlock': {
  const { hash, tokenId, amount, timelock, routingPacket } = accountTx.data;

  // Check if we already have this hashlock
  if (accountMachine.hashlocks.has(hash)) {
    return { success: false, error: 'Duplicate hashlock', events };
  }

  // Check capacity
  const delta = accountMachine.deltas.get(tokenId);
  const derived = deriveDelta(delta!, accountMachine.isProposer);

  if (isOurFrame && amount > derived.outCapacity) {
    return { success: false, error: 'Insufficient capacity for hashlock', events };
  }

  // Lock the funds
  const hashlock: HashlockEntry = {
    hash,
    amount,
    tokenId,
    timelock,
    state: 'pending',
    routingPacket
  };

  accountMachine.hashlocks.set(hash, hashlock);

  // Adjust capacity (funds are locked, not transferred yet)
  if (isOurFrame) {
    delta!.offdelta += amount; // Temporarily reduce our capacity
  }

  events.push(`🔒 Added hashlock ${hash.slice(0, 8)} for ${amount}`);

  // Trigger forwarding in entity machine
  if (!isOurFrame) {
    // Process routing packet to determine next hop
    env.pendingHashlockForwards.push({
      accountMachineId: accountMachine.id,
      hashlock
    });
  }

  return { success: true, events };
}

case 'settle-hashlock': {
  const { hash, secret } = accountTx.data;

  const hashlock = accountMachine.hashlocks.get(hash);
  if (!hashlock || hashlock.state !== 'pending') {
    return { success: false, error: 'Hashlock not found or already settled', events };
  }

  // Verify secret
  if (keccak256(secret) !== hash) {
    return { success: false, error: 'Invalid secret', events };
  }

  // Settle the hashlock
  hashlock.state = 'settled';

  // Transfer is already applied via offdelta when hashlock was added
  // Just need to clean up

  events.push(`✅ Settled hashlock ${hash.slice(0, 8)} with secret`);

  // Propagate secret backwards
  if (hashlock.incomingChannelId) {
    env.pendingSecretPropagations.push({
      channelId: hashlock.incomingChannelId,
      hash,
      secret
    });
  }

  return { success: true, events };
}
```

#### Step 3: E-Machine Handles Forwarding
```typescript
// In entity-consensus.ts - After processing account inputs
async function processHashlockForwards(env: Env, entityId: string): Promise<EntityInput[]> {
  const outputs: EntityInput[] = [];

  for (const forward of env.pendingHashlockForwards) {
    const accountMachine = env.accountMachines.get(forward.accountMachineId);
    if (!accountMachine) continue;

    const hashlock = forward.hashlock;

    // Decrypt routing packet
    const entityPrivKey = await getEntityPrivateKey(entityId);
    const { data, nextPacket } = peelOnionLayer(
      hashlock.routingPacket!,
      entityPrivKey
    );

    if (data.finalData) {
      // We are the final recipient
      const secret = data.finalData.secret;

      // Settle incoming hashlock
      accountMachine.mempool.push({
        type: 'settle-hashlock',
        data: { hash: hashlock.hash, secret }
      });

      console.log(`🎯 Final recipient of payment: ${data.finalData.description}`);
    } else if (data.nextHop) {
      // Forward to next hop
      const nextAccountMachine = env.accountMachines.get(
        `${entityId}:${data.nextHop}`
      );

      if (nextAccountMachine) {
        // Calculate fee (optional)
        const fee = data.amount * 1n / 1000n; // 0.1% fee
        const forwardAmount = data.amount - fee;

        // Add outgoing hashlock
        nextAccountMachine.mempool.push({
          type: 'add-hashlock',
          data: {
            hash: hashlock.hash,
            tokenId: data.tokenId,
            amount: forwardAmount,
            timelock: hashlock.timelock - 3600000, // Reduce by 1 hour
            routingPacket: nextPacket!
          }
        });

        // Track connection for secret propagation
        hashlock.outgoingChannelId = `${entityId}:${data.nextHop}`;
      }
    }
  }

  env.pendingHashlockForwards.length = 0;
  return outputs;
}
```

## 3. Path Finding with Dijkstra

### 3.1 Overview
Path finding determines the optimal route for multi-hop payments through the network based on channel capacities and fees.

### 3.2 Network Graph Structure

```typescript
// In routing/graph.ts
interface ChannelEdge {
  from: string;
  to: string;
  capacity: bigint;
  baseFee: bigint;
  feeRate: number; // Parts per million
  minHTLC: bigint;
  maxHTLC: bigint;
  disabled: boolean;
}

interface NetworkGraph {
  nodes: Set<string>; // Entity IDs
  edges: Map<string, ChannelEdge[]>; // Adjacency list

  // Channel capacity tracking
  channelCapacities: Map<string, {
    outbound: bigint;
    inbound: bigint;
  }>;
}
```

### 3.3 Route Finding Implementation

```typescript
// In routing/pathfinding.ts
interface Route {
  path: string[];
  totalFee: bigint;
  totalAmount: bigint;
  probability: number; // Success probability estimate
}

export class PathFinder {
  constructor(private graph: NetworkGraph) {}

  findRoutes(
    source: string,
    target: string,
    amount: bigint,
    maxRoutes: number = 3
  ): Route[] {
    // Dijkstra with modifications for Lightning-style routing
    const distances = new Map<string, bigint>();
    const previous = new Map<string, string>();
    const fees = new Map<string, bigint>();
    const visited = new Set<string>();

    // Priority queue entries: [cost, node, path]
    const pq: Array<[bigint, string, string[]]> = [[0n, source, [source]]];
    distances.set(source, 0n);
    fees.set(source, 0n);

    const routes: Route[] = [];

    while (pq.length > 0 && routes.length < maxRoutes) {
      // Sort by cost (inefficient but simple)
      pq.sort((a, b) => Number(a[0] - b[0]));
      const [currentCost, current, path] = pq.shift()!;

      if (visited.has(current)) continue;

      // Found target
      if (current === target) {
        routes.push({
          path,
          totalFee: fees.get(current)!,
          totalAmount: amount + fees.get(current)!,
          probability: this.calculateProbability(path, amount)
        });
        continue;
      }

      visited.add(current);

      // Explore neighbors
      const edges = this.graph.edges.get(current) || [];
      for (const edge of edges) {
        if (visited.has(edge.to)) continue;
        if (edge.disabled) continue;

        // Check capacity
        const requiredAmount = this.calculateRequiredAmount(
          amount,
          path.concat([edge.to]),
          target
        );

        if (requiredAmount > edge.capacity) continue;

        // Calculate cost (fee + risk)
        const edgeFee = this.calculateFee(edge, requiredAmount);
        const totalFee = fees.get(current)! + edgeFee;
        const cost = totalFee + this.calculateRiskPenalty(edge, requiredAmount);

        // Update if better path found
        if (!distances.has(edge.to) || cost < distances.get(edge.to)!) {
          distances.set(edge.to, cost);
          fees.set(edge.to, totalFee);
          previous.set(edge.to, current);
          pq.push([cost, edge.to, path.concat([edge.to])]);
        }
      }
    }

    return routes.sort((a, b) => Number(a.totalFee - b.totalFee));
  }

  private calculateFee(edge: ChannelEdge, amount: bigint): bigint {
    return edge.baseFee + (amount * BigInt(edge.feeRate)) / 1000000n;
  }

  private calculateRequiredAmount(
    finalAmount: bigint,
    path: string[],
    target: string
  ): bigint {
    // Work backwards from target to calculate required amount at each hop
    let amount = finalAmount;

    for (let i = path.length - 1; i > 0; i--) {
      const edge = this.getEdge(path[i - 1], path[i]);
      if (edge) {
        amount = amount + this.calculateFee(edge, amount);
      }
    }

    return amount;
  }

  private calculateProbability(path: string[], amount: bigint): number {
    // Simple probability model based on channel utilization
    let probability = 1.0;

    for (let i = 0; i < path.length - 1; i++) {
      const edge = this.getEdge(path[i], path[i + 1]);
      if (edge) {
        const utilization = Number(amount) / Number(edge.capacity);
        // Higher utilization = lower success probability
        probability *= Math.exp(-utilization * 2);
      }
    }

    return probability;
  }

  private calculateRiskPenalty(edge: ChannelEdge, amount: bigint): bigint {
    // Add penalty for risky channels (low capacity, high utilization)
    const utilization = Number(amount) / Number(edge.capacity);
    const penalty = BigInt(Math.floor(Number(amount) * utilization * 0.01));
    return penalty;
  }

  private getEdge(from: string, to: string): ChannelEdge | undefined {
    const edges = this.graph.edges.get(from) || [];
    return edges.find(e => e.to === to);
  }
}
```

### 3.4 Integration with Entity Machine

```typescript
// In entity-tx/handlers/routing.ts
export async function findPaymentRoute(
  env: Env,
  source: string,
  target: string,
  tokenId: number,
  amount: bigint
): Promise<string[] | null> {
  // Build network graph from current account machines
  const graph = buildNetworkGraph(env, tokenId);

  // Find routes
  const pathFinder = new PathFinder(graph);
  const routes = pathFinder.findRoutes(source, target, amount);

  if (routes.length === 0) {
    console.log(`❌ No route found from ${source} to ${target} for ${amount}`);
    return null;
  }

  // Select best route (lowest fee by default)
  const bestRoute = routes[0];
  console.log(`✅ Found route: ${bestRoute.path.join(' → ')}, fee: ${bestRoute.totalFee}`);

  return bestRoute.path;
}

function buildNetworkGraph(env: Env, tokenId: number): NetworkGraph {
  const graph: NetworkGraph = {
    nodes: new Set(),
    edges: new Map(),
    channelCapacities: new Map()
  };

  // Add all entities as nodes
  for (const entityId of env.entityReplicas.keys()) {
    graph.nodes.add(entityId);
    graph.edges.set(entityId, []);
  }

  // Add edges from account machines
  for (const [key, accountMachine] of env.accountMachines) {
    const [entity1, entity2] = key.split(':');
    const delta = accountMachine.deltas.get(tokenId);

    if (delta) {
      const derived = deriveDelta(delta, true);

      // Add edge from entity1 to entity2
      graph.edges.get(entity1)?.push({
        from: entity1,
        to: entity2,
        capacity: derived.outCapacity,
        baseFee: 0n, // TODO: Configure fees
        feeRate: 1000, // 0.1%
        minHTLC: 1n,
        maxHTLC: derived.outCapacity,
        disabled: false
      });

      // Add reverse edge
      const reverseDerived = deriveDelta(delta, false);
      graph.edges.get(entity2)?.push({
        from: entity2,
        to: entity1,
        capacity: reverseDerived.outCapacity,
        baseFee: 0n,
        feeRate: 1000,
        minHTLC: 1n,
        maxHTLC: reverseDerived.outCapacity,
        disabled: false
      });
    }
  }

  return graph;
}
```

## 4. Complete Payment Flow Example

### Direct Payment Flow
1. User initiates: `entity.sendDirectPayment(recipientId, tokenId, amount)`
2. E-Machine creates DirectPaymentEntityTx
3. E-Machine processes tx, creates AccountInput for recipient
4. AccountInput added to A-Machine mempool
5. A-Machine proposes frame with payment
6. Counterparty A-Machine acknowledges
7. Payment complete, balances updated

### Hashlock Payment Flow
1. User initiates: `entity.sendPayment(recipientId, tokenId, amount)`
2. E-Machine finds route using PathFinder
3. E-Machine creates HashlockPaymentEntityTx with route
4. E-Machine generates secret, creates onion packet
5. First hop A-Machine receives add-hashlock
6. Each intermediary:
   - Peels onion layer
   - Forwards with reduced amount (minus fee)
   - Tracks incoming/outgoing hashlock connection
7. Final recipient:
   - Reveals secret
   - Settles hashlock
8. Secret propagates backwards:
   - Each hop settles with previous
   - Fees collected by intermediaries
9. Payment complete

## 5. Error Handling

### Capacity Errors
- Check capacity before adding hashlock
- Cancel hashlock if forward fails
- Propagate cancellation backwards

### Timeout Handling
- Monitor hashlock timelocks in server tick
- Auto-cancel expired hashlocks
- Return funds to sender

### Route Failures
- Retry with alternative routes
- Implement route probing
- Update capacity estimates based on failures

## 6. Security Considerations

### Hash Preimage Security
- Use cryptographically secure random for secrets
- Never reuse secrets
- Store secrets securely until revelation

### Onion Routing Privacy
- Each hop only knows previous and next
- Amount can be obscured with overpayment
- Timing correlation resistance

### Fee Griefing Prevention
- Minimum hashlock amounts
- Rate limiting per entity
- Reputation tracking

## 7. Testing Strategy

### Unit Tests
1. Direct payment with sufficient capacity
2. Direct payment with insufficient capacity
3. Hashlock creation and settlement
4. Hashlock timeout and cancellation
5. Multi-hop payment success
6. Multi-hop payment partial failure

### Integration Tests
1. 3-hop payment through network
2. Concurrent payments in both directions
3. Network-wide rebalancing
4. Mass payment scenarios
5. Failure recovery and consistency

### Performance Tests
1. 1000 payments/second throughput
2. 10-hop payment latency
3. Route finding with 10,000 nodes
4. Onion encryption/decryption overhead

## Implementation Status (2026-01-24)

### Phase 1: Direct Payments ✅ COMPLETE
- [x] DirectPaymentEntityTx type
- [x] E-Machine handler
- [x] A-Machine processor
- [x] Basic testing

### Phase 2: HTLCs 🟡 PARTIAL
- [x] Hashlock data structures (see runtime/types.ts)
- [x] Add/Settle/Cancel handlers (account-tx/htlc.ts)
- [x] Secret management
- [x] Timeout monitoring (crontab)
- [ ] Envelope encryption (BLOCKING for mainnet)

### Phase 3: Onion Routing 🟡 PARTIAL
- [ ] Encryption utilities (ECIES or HMAC)
- [x] Packet structure (cleartext in Phase 2)
- [x] Forwarding logic (entity-tx/htlc.ts)
- [ ] Privacy testing

### Phase 4: Path Finding 🟡 PARTIAL
- [x] Network graph builder (conceptual)
- [x] BFS pathfinding (gossip-based)
- [ ] Dijkstra implementation
- [ ] Fee calculation
- [ ] Route selection

### Phase 5: Integration 🟡 PARTIAL
- [x] Multi-hop payments (4-hop tested)
- [x] Error handling (basic)
- [ ] Performance optimization
- [ ] Comprehensive testing

## Appendix A: Message Formats

### EntityInput with Payment
```typescript
{
  entityId: "entity123",
  signerId: "signer456",
  entityTxs: [{
    type: "hashlock-payment",
    data: {
      route: ["hub1", "hub2"],
      finalRecipient: "entity789",
      tokenId: 1,
      amount: 1000000n,
      description: "Invoice #123"
    }
  }]
}
```

### AccountFrame with Hashlocks
```typescript
{
  frameId: 42,
  timestamp: 1703001234567,
  accountTxs: [{
    type: "add-hashlock",
    data: {
      hash: "0xabcd...",
      tokenId: 1,
      amount: 1000000n,
      timelock: 1703005000000,
      routingPacket: "encrypted..."
    }
  }],
  tokenIds: [1],
  deltas: [500000n], // Net position after hashlocks
  hashlockCount: 1
}
```

## Appendix B: Configuration

### Payment Configuration
```typescript
interface PaymentConfig {
  maxPaymentAmount: bigint;      // 1000 ETH equivalent
  minPaymentAmount: bigint;      // 1 wei
  maxRouteLength: number;        // 10 hops
  baseRoutingFee: bigint;        // 1000 wei
  routingFeeRate: number;        // 1000 = 0.1%
  hashlockTimeout: number;       // 3600000ms per hop
  maxConcurrentHashlocks: number; // 100 per channel
}
```

---
End of Payment System Specification v1.0