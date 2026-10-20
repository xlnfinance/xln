# Evaluated E2E discovery and Observer verification

The full production-equivalent browser runner failed before executing tests because
its source parser treated `${symbol}` and `${group}` as literal test names. Discovery
now uses Playwright's evaluated metadata once, retaining owning files, source lines,
exact selectors, QA categories and MM/custody requirements. The real faucet matrix
expands to six cases. Missing or ambiguous exact selectors fail loudly.

The first subsequent browser failure was an obsolete operator test: `/app` now opens
the React wallet. The test uses the existing Observer route, verifies all five
imported runtimes, selects H1 through the real graph control, reloads, and reads
Diagnostics **Persisted** before scanning that exact stored frame. Graph options
wait for all authenticated projections within the existing 30-second startup budget;
the previous default five-second assertion was shorter than the 16-second read timeout.

QA HTTP was deliberately removed from production in `2b2c1081c`. Its absence is now
asserted as HTTP 404 rather than visiting an unsupported cockpit and producing five
expected network errors. Strict browser-health verification remains enabled. Direct
offline QA handler tests remain intact. The stale Health-to-QA link and polling QA
page are separate outstanding UI issues.

Focused evidence: discovery **2/2, 6 assertions**, existing requirement discovery
**1/1, 3 assertions**, production QA isolation **1/1, 7 assertions**, and the actual
operator browser test **1/1**, zero skips, strict browser-health passed in **137.496s**.
The selective rerun ledger was cleared by the canonical successful run.

[Proof and artifact hashes](proof.json) preserve the original full-suite failure:
**4 passed, 1 failed, 153 not run**. The complete 158-case browser suite, full release,
soak and mainnet acceptance are not certified by this focused milestone. No financial
runtime or wallet source changed. Private traces and runtime stores are retained on
Studio and are excluded from public artifacts.
