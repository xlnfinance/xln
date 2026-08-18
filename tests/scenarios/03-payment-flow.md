# archived manual payment checklist

This file is not an executable test.

Payment behavior is now covered through:

```bash
bun run test:e2e:fast
bun core/scenarios/run.ts lock-ahb
bun core/scenarios/run.ts htlc-4hop
```

Add new payment regressions as:

- L3 Playwright for user-visible pay/receive/deeplink behavior.
- L2 runtime scenario for HTLC routing, bilateral convergence, persistence, or network delivery.
- L1 runtime unit for local accounting, envelope validation, serialization, and route math.
