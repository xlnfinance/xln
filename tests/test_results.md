# archived test result snapshot

This file used to contain a manual browser test report from 2025-10-10. It is not an authoritative status page.

Current test results are produced per run under:

```bash
.logs/e2e-parallel/
.logs/scenarios-parallel/
test-results/
```

Use these commands for fresh status:

```bash
bun run check
bun run test
bun run test:e2e:fast
bun run gate:ci
```

Do not update this file with new run results. Keep transient evidence in run logs and committed coverage requirements in code.
