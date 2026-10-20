# Native React reserve exit — 2026-10-20

A fresh React BrainVault on private Java TVM could receive a real reserve deposit, but **Sign & send** failed before broadcasting: TronWeb sends an absent HTTP body for its parameterless solid-head read, and the canonical native proxy rejected it with HTTP 400.

The proxy now accepts an absent body only for its three parameterless reads. It also exposes the two read-only methods used by the existing full/solid expiry evidence checks. Configured-host binding, method allowlists, JSON-object requirements on parameterized reads and writes, size limits, and node-signing denial remain intact. No consensus, contract, WAL or financial formulas changed.

Validation: **15/15 L1, 103 assertions**; **11/11 real browser/chain checks in 73.17 seconds, zero browser errors**. The actual React withdrawal produced a solidified SUCCESS receipt, reserve 1,000,000→0, external token balance 0→1,000,000 and nonce 0→1. The UI showed the exact balances; a real reload and password unlock retained the same identity and balances without another broadcast.

The immutable original fixture, three historical WAL directories and protected forward listeners remained unchanged. See [proof.json](proof.json) for hashes and exact checks. Screenshots were visually inspected and mask credentials; raw runtime logs and wallet stores remain private outside the repository.

This is private native TVM evidence, not public Nile or mainnet acceptance. Public chain deployment/funding, all four requested financial flows, complete browser coverage, exact final commands, release and soak remain required.
