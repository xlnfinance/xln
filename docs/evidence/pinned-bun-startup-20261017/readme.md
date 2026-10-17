# Enforce the pinned Bun before startup side effects

Base main00b63f9524f4448c37228acbb209c10df8f87747. Public deployed application was
clean f3a14e6528415c7c98da7865eb6492becb8c1c61. packageManager pins bun@1.4.0, but
its existing startup scripts forced /root/.bun/bin/bun1.3.14. During the real normal
restart, terminating workers emitted NAPI fatal reports; their elapsed lifetimes
identify the old processes. The short worker-close baseline nevertheless passed3/3.
The crash's cause and its resolution are not proved by a version change alone.

One shared startup check now selects Bun from the operator's PATH and requires the
exact packageManager version before stores, seeds, listener cleanup or service start.
Server, custody and watchtower execute that checked binary. Deployment checks the
same pin before --fresh can remove data/logs or before building its web artifact.
The remote PATH retains configured precedence. There is no older-version retry.

- First focused regression:0/2; the version gate did not exist.
- Final startup/deploy-preservation regression:14/14,60 assertions,3.199s. The real
  --fresh deployment script rejects a mismatched pin while retaining data and logs;
  existing port-owner and guarded fast-forward assertions remain unchanged.
- Canonical local production-artifact wallet:1/1,38.198s, including100USDC reserve
  funding, movement into Account,25USDC payment/fee/receipt and identity/balance reload.
- Real Linux1.4.0 native crypto and worker lifecycle:7/7,1427 assertions,5.280s.
- Actual Linux selection:old1.3.14 rejected, scoped1.4.0 accepted,0.964s.

The official Linux archive was verified against GitHub's release asset SHA256 and
installed only at /root/.local/share/xln/toolchains/bun-1.4.0/bun. Its archive/binary
digests are in linux-artifact.json. The global Bun bytes remained unchanged and no
service was switched during this artifact preparation. The first archive-layout
assertion rejected its explicit directory entry before installation; the exact
verified archive was inspected and then installed. No unchecked extraction occurred.

## Current-format recovery evidence and limits

The actual public xln-server restart preserved the current stores; zero handles
were verified before a0600 backup. The1,232,713-byte backup is preserved on both hosts
outside source, SHA256 ba7611bde73ccaaaaee76f1bfb46415e7ed6021f304a769fac3725baf9c72455.
No obsolete data was restored and no reset marker was created.

The bounded observation failed54.402s; managed readiness subsequently completed in
77.151s. A combined historical query also timed out60.042s; its exact process group
was gone and both stands free before further work. Separately bounded canonical
historical reads passed for H1/H2/H3 in9.586/29.879/29.484s. All22 Account views match
pre-restart historical state exactly; the current financial roots, credit and money
balances are unchanged. Each custody Account has one new post-restart credit-policy
frame whose previous-frame hash links to the preserved old frame. Its height2→3 is
new accepted work, not restoration corruption. The initial stricter current-height
comparison and unavailable account-history endpoint failure remain in the archive.

This is a normal current-format restart and historical financial-state comparison,
not a crash/replay ordered-outbox proof, rollback proof or a sub60s restart claim.
Public signed raw broadcast remains blocked by the explicit read-only RPC policy;
an unapplied proposal awaits owner approval. Aggregate release, full browser,
public Sepolia proof, unresolved initial public wallet reload timeout, shutdown
crash diagnosis, rollback, uninterrupted soak and MacBook catch-up remain open.

Initial full check failed18.683s on two new JSON.stringify fixture lint violations.
Exact literal JSON fixtures remove both violations without changing the ratchet;
focused repeat14/14,60 assertions,3.140s. That candidate passed check38+3 in25.651s. Review then removed the server
script's remaining later PATH override so spawned hubs and market maker inherit
the checked runtime. The full production wallet passed again1/1 in38.877s.
The final clean-SHA verifier records the unchanged committed candidate.
