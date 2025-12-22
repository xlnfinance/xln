# Bug Prevention Protocol

**Rule: NEVER ship a feature without running these checks.**

## Pre-Commit Checklist

```bash
# 1. Type check ALWAYS
bun run check

# 2. Build runtime ALWAYS (catches import errors)
bun build runtime/runtime.ts --target=browser --outdir=dist \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util

# 3. Test in browser (open localhost:8080/view)
# - Click every button
# - Check console for errors (F12)
# - Verify feature works end-to-end

# 4. Check git diff (no accidental commits)
git diff --stat

# 5. Commit with descriptive message
git commit -m "feat: X - tested, works, no console errors"
```

---

## Common Silent Failures

### Button Does Nothing

**Symptom:** Click button, nothing happens, no error visible.

**Causes:**
1. **Async function not awaited**
   ```typescript
   // ❌ BAD
   <button on:click={asyncFunction}>

   // ✅ GOOD
   <button on:click={async () => await asyncFunction()}>
   ```

2. **Try-catch swallowing errors**
   ```typescript
   // ❌ BAD
   try {
     doSomething();
   } catch (err) {
     lastAction = err.message; // Silent!
   }

   // ✅ GOOD
   try {
     doSomething();
   } catch (err) {
     console.error('CRITICAL:', err);
     alert(`ERROR: ${err.message}`); // User sees it!
     lastAction = `❌ ${err.message}`;
   }
   ```

3. **Missing await on XLN.process()**
   ```typescript
   // ❌ BAD
   XLN.process(env, inputs); // Promise not awaited!

   // ✅ GOOD
   await XLN.process(env, inputs);
   ```

4. **Topology too large (crashes silently)**
   ```typescript
   // Add entity count limit
   const totalEntities = topology.layers.reduce((s, l) => s + l.entityCount, 0);
   if (totalEntities > 200) {
     throw new Error(`Too many entities: ${totalEntities} > 200 max`);
   }
   ```

---

## Browser Console Monitoring

**ALWAYS check F12 console before saying "it works"**

```javascript
// Add to every critical function:
console.log('✅ CHECKPOINT: Function X started');
console.log('✅ CHECKPOINT: Step 1 complete');
console.log('✅ CHECKPOINT: Function X finished');

// On error:
console.error('❌ CRITICAL:', error);
console.error('❌ Stack:', error.stack);
```

---

## Testing Workflow

**Before committing ANY feature:**

```
1. Reload page (Cmd+R)
2. Open console (Cmd+Option+J)
3. Click the feature
4. See green checkpoints OR red errors
5. If red → fix before commit
6. If green → commit
```

---

## Memory: Add to CLAUDE.md

```markdown
## Bug Prevention Rule

**BEFORE every commit:**
1. Run `bun run check` (catches type errors)
2. Test feature in browser (F12 console open)
3. Look for console errors (red text)
4. If any errors → FIX before commit
5. If silent failure → add console.error() statements

**NEVER commit untested code.**
**NEVER ignore console errors.**
**NEVER swallow exceptions silently.**
```

---

## Automated Checks (TODO)

```bash
# Add to package.json
"precommit": "bun run check && bun build runtime/runtime.ts"
```

This prevents commits with broken code.

---

## Current Bug Fix

**HYBRID Button Issue:**

Likely causes:
1. Too many entities (37 total) → browser crash
2. Console error swallowed by try-catch
3. Missing await somewhere

**Debug steps:**
```javascript
// Add before createEntitiesFromTopology:
console.log('🔍 Topology:', topology);
console.log('🔍 Total entities:', topology.layers.reduce((s, l) => s + l.entityCount, 0));

// Add inside createEntitiesFromTopology:
console.log('🔍 Creating layer:', layer.name, 'count:', layer.entityCount);
```

**Fix:** Check browser console, find actual error, fix root cause.
