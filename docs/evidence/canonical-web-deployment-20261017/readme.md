# One current web deployment

The exact previous production packaging command omitted `ui/dist/index.html`,
`ui/dist/runtime.js` and `ui/dist/account-worker.js`. It produced a landing-only
archive successfully; the canonical-wallet regression failed in3.476s.

The platform deploy now builds hosted React and landing/observer from the same
main checkout. It packages and installs both current roots, requires identical
Runtime/Account-worker bytes, and rejects incomplete archives, old single-root
archives and links before replacing generated builds. The separate detached
worktree deploy and `deploy:ui` command are deleted. Use the existing canonical
`deploy:prod:frontend` command. Release authority assertions remain; the test that
positively required the retired worktree workflow is replaced by actual current
artifact installation and production-handler assertions.

Measured candidate evidence:

- Exact build/package functions:27.729s, exit0, both current roots present.
- Related deployment regressions:13/13,71 assertions,16.519s. The new artifact tests
  use real current production builds, not stub assets or a second static handler.
- Real package/install:1,308 files,61,551,753-byte archive; every installed file
  matches its archive SHA-256. No source status change.
- Actual production gateway at localhost8080:8/8 in29.080s, exit0. Installed React
  initializes a fresh wallet and real Account workers, receives relay frames,
  reloads/unlocks a deep route, compiles a0.8.36 preview with admission unavailable,
  and retains the graph observer. Runtime/worker MIME and bytes match the current
  canonical bundles. No page errors, console errors or HTTP failures; four
  headless WebGL ReadPixels performance warnings are recorded.

The browser launcher is regenerated from the current canonical local production
stand. Only import locations, public8080 port/audience and the existing browser
verifier are adapted. The actual orchestrator and static handler are unchanged;
there is no ad hoc test mount. The archive is installed into their real generated
web roots before the browser run, while all runtime data uses an isolated stand.

[Exact commands/results/hashes](results.json), [original logs and browser evidence](command-logs.tar.gz)
and the [installed-file manifest](installed-manifest.json.gz) preserve the proof.
Generated web archives and screenshots remain in
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/deploy-web-*`.

No public service, database, credential, TLS or access rule was changed. The
remote preservation guard remains in force. Actual public routing/configuration,
scoped obsolete testnet reset, deployment/rollback, complete integrated gates and
uninterrupted required soak are still open. This is not a mainnet-ready claim.
