# Testing AHB Demo - Step by Step

## PROBLEM: Old database snapshots interfere

**Solution:** Clear browser database first!

## STEPS:

1. **Open:** https://localhost:8080

2. **Open DevTools Console** (F12)

3. **Clear database:**
```javascript
await window.XLN.clearDatabaseAndHistory();
location.reload();
```

4. **After reload, run AHB directly in console:**
```javascript
const xln = window.XLN;
const env = await xln.main();
await xln.prepopulateAHB(env, xln.process);

// Verify:
console.log('Entities:', env.replicas.size);  // Should be 3
console.log('Frames:', env.history.length);   // Should be 9
console.log('Subtitle:', env.history[0].subtitle?.title);  // Should show title
```

5. **Navigate frames:**
- Press Home icon (bottom left) to go to frame 0
- Press Right arrow to step through frames
- Subtitle should appear at bottom

6. **Expected:**
- 3 entities visible in 3D (Alice, Hub, Bob)
- 9 frames total
- Subtitle overlay at bottom (large card)
- Time Machine shows "0/8" to "8/8"

## If subtitle doesn't show:

Check in console:
```javascript
env.history[0].subtitle
// Should return: {title: "...", what: "...", why: "...", ...}
```

If null → prepopulate didnt run correctly
If exists but no visual → FrameSubtitle component issue

## Alternative: Use /view Architect

1. Go to /view
2. Click: Architect (right panel)
3. Click: Economy tab
4. Click: "LVL 1 ELEMENTARY" → expand
5. Click: "A-H-B Alice-Hub-Bob"
6. Should auto-run in isolated mode

Note: /view uses isolatedEnv (separate from main UI)
