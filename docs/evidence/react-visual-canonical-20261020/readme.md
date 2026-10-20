# Canonical React wallet visual coverage

The full browser suite reached five passing cases, then failed because its wallet
screenshot scenario expected the retired Svelte context switcher. The actual browser
was on the React onboarding screen. The owning test now follows the public React
wallet through four independent viewport contexts: desktop, laptop, wide and mobile.

Each context clicks **Open a test wallet**, receives an actual **100 USDC** faucet
payment, and opens three hub Accounts through the visible UI. It captures Assets,
Account ledger detail, signed frames, dispute controls, Pay, Receive, Move, Activity,
Settings and four Swap states. The same-network book must have live asks and bids;
hub and token selection must change the displayed market. The cross ticket verifies
the destination and safety text, without claiming an executed swap. Mobile flows use
their actual Back control. No production diagnostics or injected wallet state is used.

The exact production-build browser scenario passed **1/1**, **4/4 viewports**,
**56/56 captures**, **0 skips/flaky**, and **0 browser console/network/HTTP issues**
in **289.563 seconds** (including the required build-cache refresh). The source remained unchanged during that run. The original
failure and the intermediate test-formatting failure are retained on Studio; the
canonical successful exact run cleared its selective rerun entry.

[Proof and image hashes](proof.json) identify the checked patch and private archive.
This is a QA-only milestone. Bilateral signed frames are not on-chain batch proof;
these screenshots do not certify financial execution, the full 158-case suite, the
release/soak gates or mainnet. The old Svelte-only scope toggle and unsupported history
labels are removed rather than simulated. Public deployment remains a separate proof.

The folder-width gate rejected the initial helper location (11 direct files versus
10 allowed). Moving it into `tests/utils/browser/visual/` retained the same behavior;
the focused folder check and the exact browser scenario passed again. The prior
56-image visual review found no blank page or gross layout failure, but one Recent
activity section was still loading and mobile snapshots omit controls below the
viewport. Home capacity dashes belong to All assets mode without a selected token.
These image limits are retained rather than represented as completed financial reads.
