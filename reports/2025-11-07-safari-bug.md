# safari macos bug - 2025-11-07

**Issue:** User reports "dead in Safari macOS" while Chrome works
**Severity:** 🔴 Critical (Safari = 15-20% of users)

---

## likely causes

### 1. webgpu not supported in safari (most likely)
**Status:** Safari 17+ has WebGPU behind flag
**Solution:** Ensure WebGL fallback works

**Check:**
```typescript
// Graph3DPanel.svelte:74-88
const createRenderer = async (mode: string, options) => {
  if (mode === 'webgpu') {
    try {
      const WebGPURenderer = await import('three/webgpu');
      return new WebGPURenderer({ antialias });
    } catch (error) {
      console.warn('WebGPU failed, falling back to WebGL');
    }
  }
  return new THREE.WebGLRenderer(options);
};
```

**Test:** Does fallback actually work in Safari?

---

### 2. importmap not supported (unlikely)
**Safari 16.4+** supports importmaps ✅
**Our usage:** Using dynamic import(), should be fine

---

### 3. top-level await (possible)
**Safari 15+** supports top-level await ✅
**Check:** Are we using it anywhere?

---

### 4. webxr api (if vr mode triggered)
**Safari:** No WebXR support ❌
**Fix:** Gracefully disable VR button in Safari

---

### 5. console errors specific to safari
**Need:** Actual error message from Safari console
**Action:** Ask user to open Safari DevTools (Cmd+Option+I) and screenshot errors

---

## quick test (without safari)

**Check WebGL fallback:**
```javascript
// In Chrome console:
const mode = 'webgpu';
// Simulate WebGPU failure
// Should fall back to WebGL automatically
```

**Check for Safari-specific code:**
```bash
grep -r "safari\|webkit" frontend/src/ --include="*.svelte" --include="*.ts"
```

---

## immediate fix (defensive)

**Add explicit Safari detection:**
```typescript
// Detect Safari
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

if (isSafari) {
  // Force WebGL mode (skip WebGPU attempt)
  rendererMode = 'webgl';
  console.log('[Graph3D] Safari detected, using WebGL');
}
```

---

## testing checklist

**Before claiming "Safari fixed":**
- [ ] Test on actual Safari macOS
- [ ] Check console for errors
- [ ] Verify Graph3D renders
- [ ] Test Fed Chair demo (Steps 1-3)
- [ ] Test HYBRID economy
- [ ] Check performance (FPS)

---

## browser support matrix

| Browser | WebGPU | WebGL | Status |
|---------|--------|-------|--------|
| Chrome 113+ | ✅ | ✅ | Working |
| Firefox 121+ | ✅ | ✅ | Untested |
| Safari 17+ | 🟡 Flag | ✅ | **BROKEN** |
| Edge 113+ | ✅ | ✅ | Untested |

---

## next steps

1. Add Safari detection + force WebGL
2. Test in Safari (need actual device)
3. Get console errors from user
4. Fix specific issue
5. Add browser compatibility tests

---

**Priority:** 🔴 High (20% of users)
**Confidence:** 80% it's WebGPU fallback issue
**Time to fix:** 30 minutes (once we have error message)

---

**Reported by:** User
**Date:** 2025-11-07
**Status:** Investigating (need Safari console logs)
