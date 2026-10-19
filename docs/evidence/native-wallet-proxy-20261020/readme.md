# Native wallet solidity proxy reads

The native browser wallet reached chain synchronization, then failed with HTTP 400 because the canonical API denied the two solidity reads already used by its wallet snapshot: `getaccount` and `triggerconstantcontract`. The proxy now admits POST for those two operations at the configured solidity host. Signing, transaction construction and broadcasts remain forbidden in this lane. The existing solid-head fences and RPC/native header binding are unchanged.

The regression failed before the fix and passed 6/6 with 25 assertions afterwards. The same real Chromium creation flow then passed 4/4 with zero errors and 15/15 matching served artifacts. Creating a fresh test-work Brainvault reached native Home in 5.901 seconds. See [proof.json](proof.json) for exact candidate hashes, command artifacts and limits.

This is private JavaTVM boot evidence. The fixture has no hubs, and this run does not establish native financial browser flows, public USDT support or mainnet readiness. Historical runtime WAL, original chain fixture, protected source edits and SSH listener ownership were preserved. The screenshot contains no credentials.
