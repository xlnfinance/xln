# Current React Cross and Load Testing evidence

This local candidate fixes per-Entity token catalogs in the Swap builder, flips
both chain identities, and retains the mounted wallet through an authenticated
wallet snapshot refresh. The native browser regression passed 13/13 with zero
browser errors, including a real private TVM withdrawal, one user broadcast,
unlock/reload, and rejection/recovery when the chain head advances. It is not
public Nile or mainnet evidence.

The Cross catalog/Flip case passed 1/1 and the adjacent no-market/wrong-side cases
passed 2/2. The two-user financial case subsequently passed 1/1 in 146.182 seconds.
Its obsolete live-history reader was replaced by the canonical persisted Account
frame reader, which requires the opposite party's ACK. Evidence is linked by the
exact order's signed lock and pull ID to its signed close. The full close retains
65535, the signed 78 USDC / 0.03 WETH amounts, and the separate actual 75 USDC debit
assertion. Partial cancellation uses the actual React Cancel rest button and
requires both source and destination pulls to be released. The test's dispute
branch establishes route availability after the counterparty browser closes;
it does not prove a finalized on-chain dispute.

The previously retired Load Testing browser contract is restored in React. The
original navigation/defaults/ranges/Start/Stop/metrics/responsive assertions remain.
The shared scheduler now prevents a new run until accepted work drains and checks
Stop after asynchronous pathfinding before admission. The UI binds the current
wallet authority and real orderbook owner identities; unknown owners cannot be
classified as external liquidity. No financial engine or contract formula changed.

The final focused Load browser passed 1/1 in 173.040 seconds (25.8 seconds browser),
with strict browser health. It checks three viewports, real tab clicks, no overflow,
zero Failed for an unfunded wallet, actual Pay and Swap admission after a 100 USDC
faucet, and no new attempts after Stop. The screenshot shows 400 attempted, 400
skipped and zero failed before funding. Canonical Account capacity now classifies
insufficient funds as skipped; unexpected exceptions remain failures. This is not
settled TPS or proof that every generated command completed.

Focused capacity/scheduler/orderbook L1 passed 30/30 with 212 assertions; UI types
passed. Persisted Account history L1 passed 3/3 with 11 assertions (29 other tests
filtered by the declared focused selector). Earlier failures remain in proof.json.
The browser catalog is now 158 active cases. Final full browser, exact unit/test,
check, release, soak, and financial scenarios on one committed SHA remain separate
required gates. No new candidate deployment is claimed here.

[Commands, source bindings, log hashes and failure history](proof.json).
