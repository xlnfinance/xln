# next.md - Priority Tasks

## 🔥 CURRENT PRIORITY: Production Safety

### HTLC Hardening (Security Critical)
- [ ] Hash encoding fix - Use getBytes() not toUtf8Bytes() for Solidity compat
- [ ] lockId collision fix - Include senderEntityId + random nonce
- [ ] Timelock bounds check - Prevent underflow on long routes
- [ ] htlc-timeout.ts scenario - Non-cooperative path

See: `docs/planning/active/htlc-hardening.md`

### Dispute Resolution (Prevents Fund Loss)
- [ ] Crontab detects missing ACKs / expiring HTLCs
- [ ] Auto-reveal secrets before timeout
- [ ] Auto-dispute on stale states
- Files: `entity-crontab.ts`, `account-tx/handlers/htlc-timeout.ts`

## 🚧 BACKLOG (Post-MVP)

- Onion routing (privacy)
- Smart rebalancing (optimization)
- Cross-J swaps (HashLadder)
- Graph3DPanel refactor (6000 lines)
