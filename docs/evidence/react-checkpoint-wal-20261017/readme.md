# Current React checkpoint and WAL recovery

On source base `a2eaff04621cd373751c8ea6e2146bcada938d2c`, the existing required
Runtime persistence browser scenario failed in the removed Svelte creation
menu (50.666s). It had never reached a recovery assertion.

The same scenario now uses the canonical React password wallet and current
Runtime storage readers. Both isolated wallets receive exactly 200 USDC through
two real faucet transfers. Alice creates and cancels a real USDC/WETH offer
with market maker disabled. The ordinary checkpoint owner is configured to
five frames before financial work, then 1,000 to retain a genuine WAL tail;
no checkpoint, frame, financial state or replay result is inserted.

The real browser passes 1/1 in31.103s with strict browser health. Checkpoint17
plus accepted frames18–21 restore in a new page realm after password unlock.
The complete Account state, signed state root, identities, exact capacities,
cancellation and independent Bob state match. Every retained frame hash,
post-state hash and positional outbox count/digest matches; four frames were
actually replayed. Historical Runtime frames remain absent from RAM.

Removed 772 lines of retired UI/readers and replaced them with240 lines using
current APIs. No fallback readers or positive old-format restoration remain
in this scenario. Financial and storage implementation are unchanged. Exact
funding assertions replace the old199–200 tolerance; exact checkpoint/replay
and complete Account comparisons strengthen the old generic label/balance checks.
Current replay metadata describes the recovery target; independent watcher
progress may advance the live head and is not treated as lost state.

Focused current-format tests pass5/5 with37 assertions in10.629s: exact local
quorum evidence, merged accepted WAL and committed ordered outbox restoration.
Owned TypeScript diagnostics:0 in4.792s after correcting one optional-property
read without a cast. The initial type failure remains recorded.

`results.json` records actual commands/exits/durations and exact source hashes;
`proof.json` preserves public financial/hash evidence. Raw browser traces remain
outside Git because they can contain disposable test-wallet input. Final clean
commit browser, source check and pre-push verifier are linked by the publication
record under the durable job directory; no aggregate release, public-chain,
rollback, soak, mainnet readiness or TPS claim is made here.
