# Public testnet regeneration and current wallet proof

Candidate: `f3a14e6528415c7c98da7865eb6492becb8c1c61`, clean main on Studio and
`/root/xln` on xln.finance. This records actual Anvil testnet deployment, not
mainnet activation, Sepolia financial exit proof or completion of the release bar.

The previous primary Anvil checkpoint failed to parse and RPC8545 was unavailable;
old hubs repeatedly failed restore. The current canonical deployment artifact was
built from this SHA and installed with all1322 file hashes verified. Both Anvil
chains31337/31338, three hubs, MM, custody and one watchtower are now ready.

## Verified boundaries

- Native Linux crypto:4/4,1418 assertions,2.884s. Missing native installation still
  fails loudly; no server fallback was introduced.
- Current source health:exit0,1.643s,3 hubs/self-relay,1 tower,0 open incidents,
  exact git head/code hash and clean remote source.
- Actual `https://xln.finance`:8/8,26.867s; `/app` redirects to React `/ui/`, fresh
  wallet and Account worker initialize, relay receives12 frames, deep route
  reload/unlock works, pinned compiler preview works with financial admission
  unavailable, and graph observer remains available. TLS verification enabled.
  Page errors, console warnings/errors and HTTP failures:0.
- Runtime SHA256 `714c22744cbc9fbbb626e192ba7ee3e878ed1513e16846f381938b5b9a01c54a`;
  Account worker `5eb1a38aa8d02a663289ba35ba286e2d8067d373bb7bc31e80a61887ad15a945`.
- Incident journal/authority regressions:12/12,77 assertions,0.402s.

## Reset and preservation

Only existing PM2 owners `anvil`, `anvil2`, `xln-server`, `xln-watchtower` were
stopped. Zero handles were verified before deletion of the exact obsolete XLN
stores recorded in `reset-result.json`. Existing runtime seeds and watchtower key
retained identical hashes and0600 modes before and after startup. Unrelated PM2
owners retained PID/status. No mainnet/Sepolia transaction, credential rotation,
firewall/auth/TLS change or unrelated store deletion occurred.

Remote source used the canonical clean/ancestry/hidden-index guarded fast-forward,
not reset/clean. The old generated web archive remains outside source. Nginx gained
only the canonical wallet include; removing that exact include reproduces the
previous site bytes. Configuration validation and reload succeeded.

The persisted incident journal was NOT deleted. Its16,728,524-byte pre-resolution
copy has SHA256 `227477bc0e0e7944786a2d757c4b5bdf1709b3f458f4abaeab7689fa21a7bae5`
and is preserved on both hosts outside source. All17 open incidents predated the
new reset/start. `incident-resolution.json` records each fingerprint, prior count,
last observation and concrete resolution evidence. The operator API resolved each
only after checking its record had not changed; new occurrences reopen it as unread.
This does not claim obsolete oversized frames can now be restored.

## Red evidence retained

The first bundled stand tool deadlocked during module initialization, before any
service action. Its exact one-member group was stopped; byte-identical canonical
source modules then supplied the stand. An old checkout's missing stand-ignore rule
caused a dirty-source guard refusal; the exact current rule was temporarily added to
local exclude and original exclude bytes restored after fast-forward. No guard was
bypassed. The first45s bootstrap observation timed out; managed services continued
and the next bounded observation found all8 stages ready. Health's canonical reset
start/end timestamps measure114.598s, not the16ms later observation latency.

The public browser is a gateway/runtime proof, not a payment/exit or soak proof.
Aggregate release/full browser, public Sepolia financial proofs, rollback,
uninterrupted one-hour soak and MacBook catch-up remain outstanding. Command exits,
including failures, scripts and remote snapshots are in `command-evidence.tar.gz`.
