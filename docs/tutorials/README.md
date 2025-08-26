# XLN Tutorials

Welcome to XLN interactive tutorials! These guides are automatically generated from our E2E test suite, ensuring every step is validated and works correctly.

## Available Tutorials

### 🟢 Beginner

- [Quick Start: Simple Entity Creation](./quick-start-simple-entity-creation.md) - Get started in under 2 minutes
- [Basic Entity Operations](./basic-entity-operations.md) - Learn fundamental entity interactions

### 🟡 Intermediate  

- [Complete Entity & Channel Workflow](./complete-entity-channel-workflow.md) - Full end-to-end workflow
- [Multi-Signature Governance](./multi-signature-governance.md) - Democratic decision making

### 🔴 Advanced

- [Channel Dispute Resolution](./channel-dispute-resolution.md) - Handle complex scenarios
- [Cross-Chain Operations](./cross-chain-operations.md) - Multi-jurisdiction workflows

## How These Tutorials Work

🎯 **Dual Purpose**: Each tutorial serves as both documentation and automated testing  
🔄 **Always Current**: Generated from working E2E tests, never outdated  
📸 **Visual Guide**: Screenshots from actual test runs  
⚡ **Interactive**: Run `npm run tutorial` to follow along automatically  

## Running Tutorials Interactively

```bash
# Run specific tutorial interactively
npm run tutorial:complete-workflow

# Run in guided mode (slower, with explanations)
npm run tutorial:complete-workflow -- --guided

# Generate fresh documentation
npm run generate:tutorials
```

## Tutorial Architecture

Our tutorial system follows these principles:

1. **Test-Driven Documentation**: Every tutorial step is a working test
2. **Visual Validation**: Screenshots prove each step works
3. **Automatic Updates**: Documentation regenerates when tests change
4. **Multiple Modes**: Fast (CI), Guided (learning), Interactive (demo)

This ensures tutorials never go stale and always reflect the current working system.

---

*Generated automatically from E2E tests. Last updated: 2025-08-26T14:12:32.324Z*
