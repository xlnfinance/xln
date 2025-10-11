# Proofs - XLN Validation Suite

**Tests that PROVE correctness.**

---

## Directory Structure

```
/proofs/
├── README.md                           # This file
├── smoke-tests/                        # Fast sanity checks (<5s each)
│   ├── test-ethereumjs-vm.ts          # BrowserVM: Deploy + call DepositoryV1
│   ├── test-browser-evm.html          # Browser integration test
│   └── check-browser-errors.ts        # Console error detector
│
├── integration/                        # E2E scenarios (Playwright)
│   ├── tutorial-working-demo.spec.ts  # Full tutorial workflow
│   ├── payment-flow.spec.ts           # Entity creation → funding → transfer
│   ├── consensus-round.spec.ts        # BFT consensus verification
│   └── browser-evm.spec.ts            # BrowserVM panel integration
│
└── unit/                               # Unit tests (future)
    └── (runtime/ consensus logic tests)
```

---

## Test Categories

### Smoke Tests (Run Before Every Commit)

**BrowserVM Smoke Test**
```bash
bun proofs/smoke-tests/test-ethereumjs-vm.ts
# ✅ Deploys DepositoryV1.sol
# ✅ Calls debugFundReserves()
# ✅ Verifies logs emitted
# Time: ~3s
```

**Purpose:** Catch BrowserVM breakage immediately (faster than E2E)

---

### Integration Tests (Playwright E2E)

**All tests:**
```bash
bun run proofs              # Run all E2E tests
bunx playwright test        # Same, with Playwright CLI
```

**Specific test:**
```bash
bunx playwright test proofs/tutorial-working-demo.spec.ts
HEADED=true bunx playwright test proofs/browser-evm.spec.ts
```

**With notification:**
```bash
bun run test:e2e:notify     # Plays sound when done
```

---

## Test Strategy (Pyramid)

```
        /\         E2E (Playwright)         ~10 tests  (slow, comprehensive)
       /  \        Integration              ~30 tests  (medium)
      /    \       Unit                     ~200 tests (fast, future)
     /______\      Smoke                    ~5 tests   (instant validation)
```

**Current focus:** E2E + Smoke (validate core user flows + BrowserVM)
**Future:** Expand unit tests for `/runtime/` consensus logic

---

## Continuous Integration

**Pre-commit hook** (future):
```bash
#!/bin/bash
# .git/hooks/pre-commit
bun run check || exit 1  # TypeScript validation
bun proofs/smoke-tests/test-ethereumjs-vm.ts || exit 1  # BrowserVM check
```

**GitHub Actions** (future):
```yaml
name: Proofs
on: [push, pull_request]
jobs:
  smoke:
    - bun proofs/smoke-tests/test-ethereumjs-vm.ts
  e2e:
    - bunx playwright test
  deploy-preview:
    - Deploy to Vercel
```

---

## Writing New Tests

### Smoke Test Template

```typescript
#!/usr/bin/env bun
/**
 * Smoke Test: [Feature Name]
 * Purpose: Prove [specific thing] works
 * Time: <5s
 */

async function test() {
  // Setup (minimal)
  // Execute (one core operation)
  // Assert (throw on failure)

  console.log('✅ [Feature] works');
  process.exit(0);
}

test().catch(err => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
```

### E2E Test Template

```typescript
import { test, expect } from '@playwright/test';

test('[Feature] works end-to-end', async ({ page }) => {
  await page.goto('http://localhost:8080');

  // User journey (click, type, wait)
  await page.click('[data-test="action"]');
  await expect(page.locator('#result')).toBeVisible();

  // Assertions (what user should see)
  await expect(page.locator('#status')).toContainText('Success');
});
```

---

**Philosophy:** Fast feedback loop. Smoke tests catch 80% of breaks in 3s. E2E validates complete flows.
