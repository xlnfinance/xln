# XLN Scenario Architecture

## The Truth: Everything is EntityInput

There is no `xln.pay()` abstraction. XLN has ONE primitive:

```typescript
await runtime.process(env, [{
  entityId: '0x123...',
  signerId: 's1',
  entityTxs: [{ type: 'directPayment', data: {...} }]
}]);
```

## Three Layers of Scenario Definition

### Layer 1: Pure EntityInput (Lowest Level)
```javascript
export default async function(runtime) {
  const env = runtime.createEmptyEnv();

  // Raw EntityInput - what actually happens
  await runtime.process(env, [{
    entityId: generateEntityId(1),
    signerId: 's1',
    entityTxs: [{
      type: 'directPayment',
      data: {
        targetEntityId: generateEntityId(2),
        route: [generateEntityId(2)],
        amount: 100n,
        tokenId: 1
      }
    }]
  }]);

  return env;
}
```

**Pros:** Complete control, type-safe
**Cons:** Verbose, requires understanding EntityInput structure

### Layer 2: DSL Parser (Current, Works Today)
```javascript
export default async function(runtime) {
  const scenario = `
SEED my-scenario

0: Setup
grid 2 2 2

===

1: Payment
0_0_0 pay 1_0_0 100
`;

  const env = runtime.createEmptyEnv();
  const parsed = await runtime.parseScenario(scenario);
  return await runtime.executeScenario(parsed, env);
}
```

**Pros:** Works today, readable, tested
**Cons:** DSL maintenance, limited features

### Layer 3: Helper API (Future)
```javascript
export default async function(runtime) {
  const { entity, grid, pay } = runtime.api;
  const env = runtime.createEmptyEnv();

  await grid(env, 2, 2, 2);
  await pay(env, entity('0_0_0'), entity('1_0_0'), 100);

  return env;
}
```

**Pros:** Clean, type-safe (if we build it)
**Cons:** Doesn't exist yet

## Recommendation: Start with Layer 2 (DSL)

The DSL parser already exists and works. Use it:

```javascript
// any-scenario.xln.js
export default async function(runtime) {
  return await runtime.loadScenarioFromText(`
    SEED ${Date.now()}

    0: Title
    Narrative
    command params

    ===

    1: Next Frame
    More narrative
    another command
  `);
}
```

Or even simpler - just use `.scenario.txt` files directly:

```
scenarios/
├── cube-demo.scenario.txt          (current format)
├── diamond-dybvig.scenario.txt     (current format)
└── corporate-treasury.scenario.txt (new scenarios in DSL)
```

## The Real Goal: Unified XLNView

**Don't bikeshed scenario format. Focus on:**

1. **Extract 3D renderer** from NetworkTopology.svelte
2. **Create XLNView.svelte** (embeddable component)
3. **Load scenarios** (from .txt or .js, doesn't matter)
4. **Fix grid positioning** (cube not circle)
5. **Add multi-view tabs** (3D/Terminal/Panels)

The scenario format is secondary. The viewer component is primary.

## Next Action

**Create unified XLNView component** that:
- Accepts scenario (text or JS)
- Renders 3D cube correctly
- Embeddable anywhere
- Shareable URLs

Want me to:
1. Extract 3D core from NetworkTopology.svelte
2. Create XLNView.svelte
3. Fix grid positioning
4. Test in /embed route

Go?
