# Editing Large Files Efficiently (Token Optimization)

## Problem

**NetworkTopology.svelte is 5842 lines:**
- Reading entire file: ~60k tokens per edit
- With 10 edits: 600k tokens wasted
- Hit context limits fast

## Solution: Function Index + Offset Reads

**NetworkTopology.svelte has a FUNCTION INDEX at line 163-282** listing every function with exact line ranges.

### Workflow (97% token reduction)

#### Step 1: Find function in index
```typescript
/**
 * ACCOUNT BARS - RCPAN VISUALIZATION (1618-1861)
 *   createAccountBarsForConnection 1652-1733  (81 lines)
 *   deriveEntry                1747-1781
 */
```

#### Step 2: Read only that section
```typescript
Read file="/Users/egor/xln/frontend/src/lib/components/Network/NetworkTopology.svelte"
     offset=1652
     limit=82  // 81 lines + 1 for safety
```

**Result:** Read 82 lines instead of 5842 (99% reduction)

#### Step 3: Edit with exact match
```typescript
Edit file_path="/Users/egor/xln/frontend/src/lib/components/Network/NetworkTopology.svelte"
     old_string="function createAccountBarsForConnection(...entire function...)"
     new_string="function createAccountBarsForConnection(...modified version...)"
```

### Token Savings

| Approach | Tokens | Savings |
|----------|--------|---------|
| Read full file (5842 lines) | ~60k | 0% |
| Read function only (100 lines) | ~1k | **98%** |
| Read + Edit (typical) | ~2k | **97%** |

**With 10 edits:**
- Old way: 600k tokens
- New way: 20k tokens
- **Savings: 580k tokens** (29 edits for free!)

## Maintaining the Index

### When functions move (after edits)

The index line numbers will drift. **Regenerate periodically:**

```bash
# Auto-generate fresh index
awk '/^  function / {
  start=NR;
  name=$2;
  gsub(/\(.*/, "", name)
}
/^  }$/ && start {
  printf "%s:%d-%d\n", name, start, NR;
  start=0
}' frontend/src/lib/components/Network/NetworkTopology.svelte | sort
```

**Paste output back into index (lines 175-262).**

### When to update index

- After major refactoring session (5+ function edits)
- When line numbers feel stale
- Before starting new session (fresh reference)

**Don't update obsessively** - index drifting by ±50 lines is fine, you'll still get 95% token savings.

## Other Large Files

This pattern works for ANY file >1000 lines:

1. **Add function index** at top of file
2. **Use grep + offset reads** for edits
3. **Regenerate index** monthly

### Candidates for function index:
- `AccountPanel.svelte` (1609 lines)
- `SettingsView.svelte` (1201 lines)
- `EntityPanel.svelte` (1100 lines)

## Memory Hook for Claude

**When editing NetworkTopology.svelte:**

1. Check function index (lines 163-282)
2. Use offset read (NOT full file read)
3. Only read full file if:
   - Adding new imports (need to see imports section)
   - Debugging unknown error (need context)
   - Major restructure (need full view)

**Default:** Grep → Index → Offset Read → Edit

## Example Session

```typescript
// User: "Fix the force-directed layout to prevent entities from overlapping"

// ❌ BAD (60k tokens):
Read file="/Users/egor/xln/frontend/src/lib/components/Network/NetworkTopology.svelte"

// ✅ GOOD (1k tokens):
// Check index: applyForceDirectedLayout is lines 1043-1182
Read file="/Users/egor/xln/frontend/src/lib/components/Network/NetworkTopology.svelte"
     offset=1043
     limit=140

// Now edit just that function
Edit old_string="function applyForceDirectedLayout(...)"
     new_string="..."
```

## Future Optimization

Could build a **line-range cache** for all large files:
```json
{
  "NetworkTopology.svelte": {
    "lastIndexed": "2025-10-06",
    "functions": {
      "applyForceDirectedLayout": [1043, 1182],
      "createAccountBarsForConnection": [1652, 1733]
    }
  }
}
```

Store in `.claude/large-file-index.json`, auto-update on save.

But manual index works fine for now - **don't over-engineer.**
