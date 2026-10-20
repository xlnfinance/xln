# Native wallet snapshot source advancement

The live JavaTVM reproduction crossed solid head 53 to 54 during one wallet read. Rejecting all balances was correct. React previously displayed the same generic failure for this source advancement and for an inconsistent same-height header.

The canonical reader now attaches a validated source-advance disposition to a rejected read. Every source fence remains: changed heights, hashes or timestamps never produce an accepted snapshot. Equal-height identity changes and regressions remain errors. The HTTP response is 409 without balances. React shows the cause, clears the rejected snapshot and keeps financial screens unavailable until its existing refresh owner obtains a complete snapshot. The advance descriptor records observed height movement, not a proof of chain ancestry. No retry loop, deadline or financial transition changed.

Evidence is bound to base `c086b3ea596e2fc10dda978850007c866aace0a8` plus the immutable patch hash in [proof.json](proof.json). L1 passed 14/14 tests with 80 assertions; runtime, React, unsafe-type, folder-width and unused-surface checks passed 5/5. Actual TVM L2 rejected an advancing source and an expired source, then recovered an identical complete balance snapshot.

The real Chromium run passed 13/13 checks with zero console, page, HTTP, RPC or observer errors. It retained the original wallet creation, native reserve funding, actual Sign & send, solidified exit conservation and unlock/reload assertions, and added real Refresh clicks through source invalidation and recovery. No RPC responses were mocked. Source headers, original WAL and unrelated source files were preserved.

- [Visible invalidation with assets unavailable](source-advanced.png)
- [Native reserve exit after reload](native-exit-reloaded.png)

The observer fixture has no hub/faucet bootstrap. Its screenshot is not a claim that hub onboarding, public Nile or mainnet is ready. The first aggregate check rejected a folder-width violation; the byte-identical helper was moved into the existing wallet directory, then focused checks and the browser were repeated. A second aggregate check caught raw JSON serialization in the new test; it now uses canonical safeStringify and passed focused L1 and lint. That correction changed only the test. A third check rejected a separately exported predicate; the HTTP consumer now uses the existing envelope decoder and the predicate is private. L1, all five affected source gates, the hosted build and the thirteen actual browser checks passed again. Earlier failed and invalid diagnostic attempts remain in the durable Studio job directory. These focused results do not replace fresh final-SHA financial scenarios, exact suites, the complete release, soak or public deployment verification.
