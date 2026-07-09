# Canonical Identity Scan

Last refreshed: 2026-07-09.

Run:

```bash
bun run security:canonical-identity
```

This is an executable source-shape and behavior scan for jurisdiction identity.
It keeps protocol identity tied to chain/depository stack refs instead of
display labels.

## Current Result

- Jurisdiction refs are `stack:<chainId>:<depository>`.
- Display names are cosmetic and cannot identify two jurisdiction objects by
  themselves.
- Non-stack strings no longer resolve through `getJReplicaByJurisdictionRef()`.
- Legacy name lookups are explicit through name-bearing APIs only.
- Hub support peers, reserve bootstrap, market-maker planning, mesh
  jurisdiction selection, and `/api/jurisdictions` preserve canonical refs or
  configured display labels without Arrakis/Testnet alias rewrites.

## Open Manual Review

- Some APIs still accept `jurisdictionName` for legacy entity tx fields and
  J-height convenience helpers. Those paths now call explicit name lookup, not
  stack-ref lookup.
- Cross-j route payloads still carry display-like `source.jurisdiction` and
  `target.jurisdiction` strings in older structs. Those should be audited
  separately before any binary/spec freeze.
