# Runtime Extensions

[Up: runtime map](./overview.md) | [Account machine](./account.md) | [Protocol primitives](./protocol.md)

Extensions add products above the bilateral core. They may submit typed account/entity transactions, but must not bypass account consensus, mutate delta fields directly, or become hidden loop owners.

## Source

- [`runtime/extensions/cross-j/`](../../runtime/extensions/cross-j) - cross-j route and fill coordination.
- [`runtime/orderbook/`](../../runtime/orderbook) - deterministic same-j matching and book state.
- [`runtime/routing/`](../../runtime/routing) - payment graph and route selection.
- [`runtime/agent-payments/`](../../runtime/agent-payments) - agent-to-agent payment integration.
- [`runtime/extensions/lending.ts`](../../runtime/extensions/lending.ts) - lending projection pending final folder migration.

## Main Methods

- `applyCommand(...)` - applies deterministic orderbook commands.
- `buildPreparedCrossJurisdictionRoute(...)` - constructs a bound cross-j route.
- `withCanonicalCrossJurisdictionRouteHash(...)` - commits route fields canonically.
- `findPaymentRoute(...)` - selects a route from advertised capacities.
- `deriveDelta(...)` - remains the only economic delta derivation boundary used by extensions.

## Invariant

An extension can propose work, never redefine settlement truth. Consensus state remains in E/A/J machines; retry policy, caches, and automation remain private shadow or infrastructure state.
