# XLN Scenario Specification

## Overview

Scenarios are programmable economic narratives that unfold over time in XLN. They enable:
- **Demonstration**: Show financial mechanisms (bank runs, payment flows, liquidity crises)
- **Testing**: Validate consensus and state transitions under complex conditions
- **Education**: Share economic concepts as interactive, reproducible experiences
- **Research**: Explore mechanism design in controlled environments

Each scenario is a deterministic script that feeds events to the XLN server, producing a chain of ServerFrames that can be visualized, shared, and remixed.

## Philosophy

- **Minimalist syntax**: Human-readable text format inspired by screenplay/subtitle timing
- **Deterministic**: Same scenario + same seed = identical outcome
- **Composable**: Scenarios can include other scenarios
- **Cinematic**: Camera angles and view state are part of the experience
- **Shareable**: URL-encodable for frictionless distribution
- **Remixable**: Fork, edit, loop, and re-share

## File Format

### Basic Structure

```
SEED <seed-string>

<timestamp>: <optional-title>
<optional-multiline-description>
<action1>
<action2>

===

<next-timestamp>: <title>
<action>
```

### Example

```
SEED diamond-dybvig-2024

0: Genesis - Initial entities
Various entities representing banks and depositors are created
import 1..6

===

1: Establishing first account
Entity 2 opens account with entity 1
2 openAccount 1

===

2.5: Network expansion
Other entities open accounts with main hubs
3..4 openAccount 1
5..6 openAccount 2

===

5: Initial deposits
Alice and Bob deposit funds
3 deposit 1 500 jurisdiction=ethereum
4 deposit 1 500 jurisdiction=ethereum

===

10: Fractional reserve lending begins
Bank lends out most deposits, maintaining minimal reserves
VIEW camera=orbital zoom=2.0 focus=1
1 loan 5 800

===

15: Bank run triggers
Depositors simultaneously withdraw - insufficient reserves
3 withdraw 1 500
4 withdraw 1 500

===

20: System stabilizes
VIEW camera=overview zoom=1.0
```

## Syntax Reference

### Seed Declaration

```
SEED <seed-string>
```

- **Required**: Must be first non-comment line if deterministic behavior needed
- **Default**: Empty string if omitted
- **Purpose**: Seeds all randomness (nonces, timing jitter, etc.)

### Timestamps

```
<seconds>: <title>
<description>
```

- **Format**: Decimal seconds (e.g., `0`, `1.5`, `10.25`)
- **Title**: Optional, human-readable event name
- **Description**: Optional, multiline explanation (until first action or separator)

### Frame Separator

```
===
```

- Visual separator between timestamp blocks
- Optional but recommended for readability

### Comments

```
# This is a comment
```

- Ignored by parser
- Can appear anywhere

### Actions

#### Basic Action Format

```
<entityId> <actionType> <param1> <param2> ... key=value
```

**Examples:**
```
2 openAccount 1
3 deposit 1 500
4 withdraw 2 250 jurisdiction=ethereum token=USDC
```

#### Range Expansion

```
<start>..<end> <action>
```

Expands to sequential execution at same timestamp.

**Example:**
```
3..5 openAccount 1
```
Expands to:
```
3 openAccount 1
4 openAccount 1
5 openAccount 1
```

#### Cartesian Product

```
<range1> <action> <range2>
```

**Example:**
```
3..4 openAccount 1..2
```
Expands to:
```
3 openAccount 1
3 openAccount 2
4 openAccount 1
4 openAccount 2
```

### Special Actions

#### Import Entities

```
import <entityId>
import <start>..<end>
```

Creates entities with sequential IDs. Each entity is a single-signer entity with `signerId=0`, registered on-chain.

**Examples:**
```
import 1
import 1..10
```

#### View State

```
VIEW <param>=<value> ...
```

Sets camera and UI state for this frame. Stored in ServerFrame for cinematic playback.

**Parameters:**
- `camera`: `orbital` | `overview` | `follow` | `free`
- `zoom`: Float (e.g., `1.0`, `2.5`)
- `focus`: Entity ID to center on
- `panel`: UI panel to show (e.g., `accounts`, `transactions`, `consensus`)
- `speed`: Playback speed multiplier

**Example:**
```
VIEW camera=orbital zoom=2.0 focus=3 panel=accounts speed=0.5
```

#### Repeat Blocks

```
REPEAT <interval-seconds>
<action1>
<action2>
...
END_REPEAT
```

Repeats the enclosed actions every `<interval>` seconds for the duration of the scenario.

**Example:**
```
5: Continuous cashflow begins
REPEAT 5
3 deposit 1 100
4 withdraw 2 50
END_REPEAT

10: Other events continue...
```

This executes the deposit/withdraw at t=5, 10, 15, 20, ... until scenario ends.

#### Include Other Scenarios

```
INCLUDE <relative-path>
```

Merges another scenario's timeline relatively (timestamps are offset by current position).

**Example:**
```
SEED base-economy

0: Setup base economy
INCLUDE ../common/bootstrap.scenario.txt

===

50: Trigger crisis
INCLUDE crisis-events.scenario.txt
```

If `crisis-events.scenario.txt` starts at t=0, its events execute at t=50 in the parent scenario.

## Action Types

### Entity Management

- `import <id>` - Create entity with given ID
- `destroy <id>` - Remove entity from system

### Account Lifecycle

- `<entityId> openAccount <counterpartyId>` - Open bilateral account
- `<entityId> closeAccount <counterpartyId>` - Close bilateral account

### Transactions

- `<entityId> deposit <counterpartyId> <amount> [jurisdiction=<jid>] [token=<tid>]`
- `<entityId> withdraw <counterpartyId> <amount> [jurisdiction=<jid>] [token=<tid>]`
- `<entityId> transfer <counterpartyId> <amount>` - Off-chain transfer
- `<entityId> loan <counterpartyId> <amount>` - Issue loan (negative balance)

### Governance (Future)

- `<entityId> changeQuorum <newThreshold>`
- `<entityId> addJurisdiction <jurisdictionId>`

### Meta

- `PAUSE <duration>` - Wait without events (for dramatic effect)
- `ASSERT <condition>` - Verify invariant (for testing)

## Determinism Guarantees

1. **Seed-based randomness**: All non-determinism derives from declared SEED
2. **Sequential execution**: Actions at same timestamp execute in declaration order
3. **Frame consistency**: Same scenario always produces identical ServerFrame chain
4. **View reproducibility**: Camera state stored per-frame ensures identical playback

## URL Encoding

Scenarios can be shared via URL:

```
https://xln.finance/s/<base64-encoded-scenario>?loop=30:45&speed=0.5
```

**Query Parameters:**
- `loop=<start>:<end>` - Loop frames start to end (in seconds)
- `speed=<float>` - Playback speed multiplier
- `autoplay=<bool>` - Start playing immediately
- `edit=<bool>` - Show editor panel

**Shorthand URLs** (future):
```
https://xln.finance/s/diamonddybvig
```
Maps to full scenario via server-side key-value store.

## File Organization

```
/scenarios/
  diamond-dybvig.scenario.txt       # Classic bank run
  payment-routing.scenario.txt      # Multi-hop payments
  liquidity-crisis.scenario.txt     # Network-wide stress test
  /common/
    bootstrap.scenario.txt          # Reusable base economy setup
  /tradfi/
    fractional-reserve.scenario.txt
    clearing-settlement.scenario.txt
  /research/
    novel-mechanism.scenario.ts     # Advanced programmatic scenarios
```

## TypeScript Scenarios

For advanced use cases, scenarios can be authored in TypeScript:

```typescript
// scenarios/procedural-bank-run.scenario.ts
import { Scenario, ScenarioEvent } from '../src/scenarios/types';

export const proceduralBankRun: Scenario = {
  seed: 'procedural-2024',
  events: [
    { timestamp: 0, action: 'import', params: ['1..10'] },
    ...Array.from({ length: 100 }, (_, i) => ({
      timestamp: i * 0.1,
      action: 'deposit',
      params: [`${(i % 9) + 2}`, '1', String(Math.random() * 1000)],
    })),
  ],
};
```

## Integration with Time Machine

The frontend time machine:
1. **Loads** scenario from URL or file
2. **Parses** into event stream
3. **Executes** via `server.processInput()` to build ServerFrame chain
4. **Plays** frames with cinematic camera transitions
5. **Allows** scrubbing, pausing, editing, looping
6. **Exports** modified scenario or sliced loops

## Best Practices

1. **Start simple**: Use basic actions, add complexity gradually
2. **Name meaningfully**: Titles should convey economic narrative
3. **Document assumptions**: Use descriptions to explain context
4. **Test invariants**: Use ASSERT to validate expected state
5. **Compose liberally**: Break large scenarios into reusable includes
6. **Version with seeds**: Change seed to create variations of same scenario

## Example: Diamond-Dybvig Bank Run

See `/scenarios/diamond-dybvig.scenario.txt` for complete reference implementation.

## Future Extensions

- **Conditional execution**: `IF <condition> THEN <action>`
- **Variables**: `SET reserve_ratio = 0.2`, `USE reserve_ratio`
- **Parametric scenarios**: URL params override scenario variables
- **Stochastic modes**: `RANDOM SEED` for exploration vs demonstration
- **Multi-jurisdiction**: Cross-chain events and timing
- **Narrative overlays**: Rich multimedia annotations (images, charts, explanations)
