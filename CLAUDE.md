# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

XLN (Cross-Local Network) is a cross-jurisdictional off-chain settlement network enabling distributed entities to exchange messages and value instantly off-chain while anchoring final outcomes on-chain. This repository contains planning and specifications for a chat-only MVP demonstrating Byzantine Fault Tolerant (BFT) consensus.

## Architecture

The system follows a layered architecture with pure functional state machines:

### Core Layers

- **Entity Layer**: BFT consensus state machine handling ADD_TX → PROPOSE → SIGN → COMMIT flow
- **Server Layer**: Routes inputs every 100ms tick, maintains global state via ServerFrames
- **Runtime Layer**: Side-effectful shell managing cryptography and I/O

## Development Commands

Since this is a planning repository without implementation yet, the intended commands would be:

```bash
# Install dependencies
bun install

# Run the demo
bun run index.ts

# Future commands (when implemented):
# bun test         # Run tests
# bun run build    # Build for production
```

### Determinism Requirements

- Transactions sorted by: nonce → from → kind → insertion-index
- All timestamps use bigint unix-ms
- RLP encoding ensures canonical binary representation
- Keccak-256 hashing for frame and state root computation

## Implementation Guidelines

### State Management

- Pure functions for all consensus logic: `(prevState, input) → {nextState, outbox}`
- No side effects in entity.ts or server.ts
- Deterministic transaction ordering via sorting rules
- Nonce-based replay protection per signer

### Cryptography

- Addresses derived as keccak256(pubkey)[-20:]
- Aggregate signatures for efficient consensus proofs

### Persistence (Future)

- Write-Ahead Log (WAL) for crash recovery
- Periodic state snapshots
- Content-Addressed Storage (CAS) for audit trail
- ServerFrame logs enable deterministic replay

## Testing Approach

When implementing tests:

- Unit test pure state machines with predictable inputs
- Integration test the full consensus flow
- Verify deterministic replay from WAL
- Test Byzantine scenarios (missing signatures, invalid frames)

## Security Considerations


- Nonces prevent replay attacks
- Frame hashes ensure integrity
- Threshold signatures provide Byzantine fault tolerance
- Merkle roots enable efficient state verification

## Memories

- remember this
- we use bun not pnpm
- Codestyle guidelines added to highlight mission, influences, and detailed TypeScript practices
- we agreed that tx for transactions are ok shortcut accepted in crypto community
