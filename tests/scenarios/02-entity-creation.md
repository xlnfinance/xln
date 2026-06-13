# archived manual entity checklist

This file is not an executable test.

Entity creation is now covered through:

```bash
bun run test:e2e:fast
bun run test:scenarios:parallel:isolated
```

Add new entity-flow regressions as:

- L3 Playwright when the user-visible creation path changes.
- L2 runtime scenario when entity registration/import behavior changes without UI changes.
- L1 runtime unit when a pure helper or validation rule changes.
