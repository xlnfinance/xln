# Pre-Deploy Checklist

**CRITICAL:** Landing page is public-facing. It MUST work perfectly.

## Before Every Deploy

```bash
cd frontend

# 1. Run landing page smoke tests
npm run test:landing

# 2. If tests fail, FIX BEFORE DEPLOYING
# 3. Only deploy if all tests pass
```

## What Gets Tested

✅ **Centering** - "Modular Contract System" heading is centered
✅ **Slot machine** - All 3 contract cards visible
✅ **MML unlock** - Navigates to /view
✅ **No 404s** - All assets load correctly
✅ **Responsive** - No horizontal overflow on mobile/tablet/desktop

## Install Playwright (First Time)

```bash
npx playwright install chromium
```

## Run All Tests

```bash
npm run test        # Run all tests
npm run test:ui     # Visual test runner
```

## Auto-Deploy Script

`auto-deploy.sh` does NOT run tests automatically (requires Playwright browsers).
**You MUST run tests locally before pushing.**
