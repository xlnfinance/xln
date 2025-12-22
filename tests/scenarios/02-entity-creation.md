# E2E Test: Entity Creation

**Purpose:** Test entity creation flow end-to-end

## Test Steps

1. Navigate to Settings
2. Click "Create Entity" button
3. Wait for blockchain transaction
4. Verify entity appears in replica map
5. Verify entity has jBlock=0
6. Verify J-Watcher syncs reserves
7. Check entity displays in UI

## Expected Results

- Entity created on-chain (EntityProvider.sol)
- Entity imported to runtime
- J-Watcher syncs ReserveUpdated events
- Entity visible in network graph
- No consensus errors

## Success Criteria

✅ Entity registered on-chain
✅ Runtime replica created
✅ Reserves populated from J-Watcher
✅ UI shows entity node
✅ Height incremented
