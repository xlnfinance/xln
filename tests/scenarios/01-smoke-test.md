# archived manual smoke checklist

This file is not an executable test.

Use the current gates instead:

```bash
bun run test
bun run test:e2e:fast
```

For browser smoke coverage, use `tests/e2e-payment-smoke.spec.ts`.

For runtime scenario coverage, use:

```bash
bun runtime/scenarios/run.ts --set=smoke
```
