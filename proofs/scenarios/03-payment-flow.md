# E2E Test: Complete Payment Flow

**Purpose:** Test full payment lifecycle (account opening → payment → settlement)

## Test Steps

1. Create Entity A (Alice)
2. Create Entity B (Bob)
3. Open account: Alice → Bob
4. Wait for bilateral consensus
5. Verify account exists in both entities
6. Send payment: Alice → Bob (100 USDC)
7. Verify bilateral frame propagation
8. Check balance updates
9. Verify state roots match

## Expected Results

### Account Opening
- Both entities create AccountMachine
- Initial deltas: {balance: 0, creditLimit: 1000, collateral: 0}
- Bilateral consensus: INIT → frame exchanged

### Payment Processing
- Alice creates payment tx
- Bilateral consensus: PROPOSE → SIGN → COMMIT
- Both compute identical state root
- Account frame height increments

### Balance Verification
- Alice balance: -100
- Bob balance: +100
- State roots match (consensus verified)

## Success Criteria

✅ Account opened bilaterally
✅ Payment processed via consensus
✅ Balances updated correctly
✅ State roots identical
✅ No consensus failures
✅ Frame history recorded
