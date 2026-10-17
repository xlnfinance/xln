# Canonical wallet through nginx

On base `d472fea06`, actual public `/ui/` returned the old Svelte shell and both current wallet assets returned404. The same missing route was reproduced with real nginx and current generated files in0.881s.

The platform now inserts one owned nginx include into the existing application host. `/ui/` and the root Account worker forward to the current Runtime HTTP handler. No separate wallet root, decoder, API authority, TLS or service-key change is introduced. Unknown competing routes fail loudly.

Configuration/checkout/release regressions:11/11,53 assertions,2.958s. Actual nginx plus canonical production Runtime/browser:8/8,28.618s, fresh wallet, real Account workers, relay, exact runtime/worker hashes, deep reload, compiler preview and observer. Zero page/console/HTTP errors; two headless WebGL performance warnings. The slash redirect additionally preserves query parameters; the clean committed browser run checks that before the eight journeys.

The deployed nginx1.24 accepted an inactive candidate using the real site/TLS/API configuration in1.179s. Its live configuration hashes were unchanged; no reload or traffic switch occurred. The local nginx executable was installed for bounded tests, without enabling a system service.

Full exact command output is in `command-logs.tar.gz`; exits and durations are in `results.json`. Clean-commit checks/publication are recorded under `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/evidence/nginx-wallet-*`. This is routing evidence, not public rollout, Sepolia proof, financial parity or mainnet readiness.
