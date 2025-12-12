# Archived Scenarios

Scenarios removed from /scenarios page to reduce site load.
Kept for reference and future re-implementation.

## Fed Chair Demo

**Description:** 3×3 hub grid with $1M per entity. Broadcast payments across the network.

**Auto-script:**
```javascript
setTimeout(async () => {
  if (window.XLN?.fundAll) {
    await window.XLN.fundAll(1000000);
    await new Promise(r => setTimeout(r, 2000));
    // Start continuous payments
    const loop = async () => {
      if (window.XLN?.r2r) {
        const from = Math.floor(Math.random() * 9).toString();
        const to = Math.floor(Math.random() * 9).toString();
        if (from !== to) {
          await window.XLN.r2r(from, to, Math.floor(Math.random() * 10000));
        }
      }
      setTimeout(loop, 1500);
    };
    loop();
  }
}, 4000);
```

## Scale Test: 100 Entities

**Description:** Stress test with 100 entities. FPS should stay at 60+.

**Auto-script:**
```javascript
setTimeout(async () => {
  if (window.XLN?.createEntities) {
    await window.XLN.createEntities(100);
  }
}, 3000);
```

## Notes

These scenarios require implementation:
- `window.XLN.r2r()` - Reserve-to-reserve transfer
- `window.XLN.fundAll()` - Fund all entities
- `window.XLN.createEntities()` - Create N entities

Currently only AHB scenario is implemented via `prepopulateAHB()`.
