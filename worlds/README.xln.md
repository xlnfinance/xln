# XLN Scenarios (.xln.js)

**Financial narratives as executable JavaScript**

## Format

Each `.xln.js` file exports a scenario object:

```javascript
export default {
  seed: 'unique-identifier',
  title: 'Human Readable Title',
  description: 'One-line summary',

  frames: [
    {
      time: 0,                    // When to execute
      title: 'Scene Title',        // Short headline
      narrative: 'What happens',   // Explanation
      camera: { ... },             // Optional camera control
      actions: async (xln, env) => {
        // JavaScript code that mutates env
        await xln.grid(2, 2, 2);
        await xln.pay(1, 2, 100);
      }
    }
  ]
};
```

## Available Actions

### Entity Management
```js
await xln.createEntity({ name, validators, threshold, reserves });
await xln.import([1, 2, 3, 4]);  // By number
await xln.import(['Alice', 'Bob']);  // By name
```

### Account Operations
```js
await xln.openAccount(from, to);
await xln.deposit(from, to, amount);
await xln.withdraw(from, to, amount);
await xln.transfer(from, to, amount);
```

### Payments
```js
await xln.pay(from, to, amount, { token: 1, route: [1,3,5,2] });
await xln.payRandom({ count, minHops, maxHops, minAmount, maxAmount });
```

### Governance
```js
await xln.propose({ entity, proposer, title, actions });
await xln.vote({ entity, proposalId, voter, choice });
```

### Grid Topology
```js
await xln.grid(x, y, z);  // Create 3D grid
await xln.connect(entity1, entity2, { capacity, creditLimit });
```

### Verification
```js
xln.assert(condition, message);
const entity = env.getEntity(id);
const account = entity.getAccount(counterpartyId);
```

## Camera Control

```js
camera: {
  mode: 'orbital' | 'overview' | 'follow' | 'free',
  zoom: 1.5,
  focus: entityId,
  speed: 0.5
}
```

## Existing Scenarios

### Financial Crises
- `diamond-dybvig.xln.js` - Bank run dynamics
- `liquidity-crisis.xln.js` - Margin call cascade (TODO)
- `flash-crash.xln.js` - Market panic (TODO)

### Corporate Operations
- `corporate-treasury.xln.js` - Multi-sig rebalancing
- `dividend-payment.xln.js` - Shareholder distribution (TODO)
- `share-buyback.xln.js` - Capital restructuring (TODO)

### Network Dynamics
- `phantom-grid.xln.js` - 3D topology demo
- `hub-failure.xln.js` - Resilience test (TODO)
- `multi-hop-routing.xln.js` - Payment routing (TODO)

### DeFi Scenarios
- `amm-arbitrage.xln.js` - Cross-protocol arbitrage (TODO)
- `liquidation-cascade.xln.js` - Collateral failures (TODO)
- `oracle-manipulation.xln.js` - Price feed attack (TODO)

## Creating New Scenarios

1. **Copy template:**
```bash
cp scenarios/phantom-grid.xln.js scenarios/my-scenario.xln.js
```

2. **Edit metadata:**
```js
export default {
  seed: 'my-unique-seed',
  title: 'My Scenario',
  description: '...',
```

3. **Define frames:**
- Each frame = one moment in time
- Add narrative for each transition
- Use async/await for XLN operations

4. **Test in browser:**
```
/embed?s=my-scenario
```

## Embedding Scenarios

### In Docs (Svelte)
```svelte
<XLNView scenario="diamond-dybvig" mode="standard" />
```

### In Blog Posts (iframe)
```html
<iframe
  src="https://xln.finance/embed?s=diamond-dybvig&v=3d"
  width="600"
  height="400"
/>
```

### Direct URL
```
https://xln.finance/embed?s=corporate-treasury&v=panels&f=7
```

## Advanced: Multi-View Scenarios

Some scenarios benefit from multiple perspectives:

```js
frames: [
  {
    time: 0,
    title: 'Setup',
    views: {
      '3d': { camera: 'overview' },
      'terminal': { focus: 'entity-1' },
      'panels': { entity: 'Tesla', panel: 'reserves' }
    },
    actions: async (xln) => { ... }
  }
]
```

This lets you show:
- **3D:** Network topology
- **Terminal:** Command being executed
- **Panels:** User wallet perspective

All synced to same timeline.

## Best Practices

1. **Keep frames short** - 1-3 actions per frame
2. **Add camera movement** - guides viewer attention
3. **Narrative is key** - explain WHY, not just WHAT
4. **Show state transitions** - before/after comparisons
5. **Build complexity gradually** - start simple, add layers

## Why JavaScript?

**vs. DSL:**
- ✅ No parser needed
- ✅ Full programming power (loops, conditions)
- ✅ Type checking (with JSDoc or TS conversion)
- ✅ IDE autocomplete
- ✅ Debuggable (breakpoints, console.log)

**vs. TypeScript:**
- ✅ Browser-native (import directly, no compilation)
- ✅ Simpler for non-programmers
- ✅ Can upgrade to .ts later (just rename)

**The `.xln.js` extension** signals: "This is executable XLN financial logic"
