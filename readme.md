# XLN: Extensible Layer-2 Network

XLN is an advanced layer-2 scaling solution for blockchain networks, designed to enhance transaction throughput, reduce fees, and enable complex financial operations off-chain.

## Key Features

1. **Multi-Asset Support**: Native support for multiple assets within a single channel
2. **Subchannel Architecture**: Modular approach for easy integration of new chains and assets
3. **Credit-Collateral Module**: Sophisticated credit system alongside traditional collateral-based channels
4. **Subcontracts**: Support for complex financial instruments like swaps and options
5. **Onion Routing**: Enhanced privacy for multi-hop payments
6. **Entity System**: Flexible identity management and multi-signature control of channels
7. **🏛️ Integrated Governance**: Meta/Alphabet-style tradable control and dividend tokens with ERC1155 efficiency

## Quick Start

### Run Tests
```bash
npm test                # Run smart contract tests
npm run test:contracts  # Run contract tests specifically
```

### View Governance Documentation
```bash
npm run demo            # Points to governance documentation
npm run docs:governance # Same as above
```

📖 **Comprehensive governance documentation:** [`docs/governance-architecture.md`](docs/governance-architecture.md)

### Development
```bash
npm run env:build       # Compile smart contracts
npm run env:run         # Start local hardhat network
npm run env:deploy      # Deploy contracts
```
