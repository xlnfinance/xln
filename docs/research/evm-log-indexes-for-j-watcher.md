# EVM log indexes for the XLN J watcher

Research checked 2026-11-18 against the TypeScript working tree at
`b2dceb3438ff2582cee0c5741fe4a0528f5cbd26` and retained public evidence.

- Keep the fresh one-USDC demo on the existing watcher. The read-only fresh
  preflight reached J readiness at 16.052 s for Hub and 35.074 s for MM from
  probe start. Both used new, unfunded stores with storage-proof-backed anchors.
  Funding, maker readiness and the public journey remain separate milestones.
  [Fresh demo preflight](../runtime/usdc-poc-fresh-demo.md#verified-startup-and-recovery)
- For ticket 12, Etherscan returned one candidate Depository block across the
  282,310-block Arbitrum gap. A separate query confirmed that its two log rows
  matched the retained deposit receipt. Authenticated restore of the original
  Hub and MM still needs contiguous history, the original stores and the
  exact subsequent restore.
  Arbitrum header delivery is the measured bottleneck. A transport experiment
  worth pursuing later would deliver full headers in bulk, with an independent
  fresh observation of the complete range through the existing RPC binding.
  [Ticket 12](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md) · [Catch-up measurements](../evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md)
- A narrower authenticated bloom predicate is the strongest local candidate
  for reducing Ethereum Sepolia receipt reads. Start with ERC-20 event
  signatures and measure the marginal value of owner filtering, which needs
  additional evidence about malformed events and wallet watch boundaries.
  [Current receipt scan](../../core/jurisdiction/adapter/receipt/reader.ts#L419) · [Wallet event decoder](../../core/jurisdiction/adapter/rpc-watcher-events.ts#L178)

## What XLN authenticates

The EVM reader gets each block plus the preceding block with
`eth_getBlockByNumber(height, false)`. It checks the requested height and
recomputes `keccak256(RLP(header))` over all applicable fields, including
`logsBloom`, `receiptsRoot` and `stateRoot`, then verifies parent links and
the expected predecessor at admission. On a bloom-positive block it fetches
all receipts, checks their count, identity and position against the block's
transaction hash list, rebuilds `receiptsRoot` and constructs receipt proofs.
It derives block-global log indices from every receipt in transaction order,
then fences the same range with a second full header observation after receipt
work. The watcher also has a separate filtered RPC dispute-reference lookup.
Cold restore's old `eth_getProof` storage audit is a separate capability.
[Range reader](../../core/jurisdiction/adapter/receipt/reader.ts) · [Header hash](../../core/jurisdiction/adapter/rpc/state-anchor/rpc-header-hash.ts) · [Watcher ingress](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-ingress.ts#L170) · [Historical proof probe](../evidence/ts-usdc-cross-j-poc/operator-funding-rpc-capability.json) · [EIP-1186](https://eips.ethereum.org/EIPS/eip-1186)

A receipt proof authenticates one receipt at a transaction index in a specific
block. It establishes inclusion of the logs in that receipt. An omitted log
in another receipt or block can leave every returned proof valid. A negative
authenticated header bloom safely rules out a required address or topic for
that block. A positive bloom leaves both real matches and collisions possible,
so XLN verifies the complete receipt set there. Etherscan and `eth_getLogs`
return log rows without a proof that the answer covers the predicate across
the range. A second provider can reveal a discrepancy, while agreement can
still miss a log omitted by both. This is why an index result, even one
backed by individual inclusion proofs, cannot justify a cursor advance on
its own. [EIP-2718 receipt commitment](https://eips.ethereum.org/EIPS/eip-2718#receipts) · [Geth bloom implementation](https://github.com/ethereum/go-ethereum/blob/master/core/types/bloom9.go) · [Execution API log response](https://ethereum.github.io/execution-apis/api/methods/eth_getLogs/) · [Etherscan log response](https://docs.etherscan.io/api-reference/endpoint/getlogs-address-topics) · [XLN receipt proof verifier](../../core/jurisdiction/machine/receipt-codec/index.ts#L181)

## Provider evidence

### Etherscan V2 and JSON-RPC

Etherscan's public V2 chain list returned status `1` and free-tier eligibility
for both Ethereum Sepolia (`11155111`) and Arbitrum Sepolia (`421614`). The
keyed REST `module=logs&action=getLogs` endpoint filters by emitting address
and numeric block range. The address-and-topics variant documents positional
topic parameters and explicit `and`/`or` operators. Both variants document
`page` and `offset`. The free-tier changelog caps address-log requests at
1,000 rows per request since 2026-07-01. The address-and-topics page gives
no separate numerical cap, so use at most 1,000 as a probe size. The free
tier publishes 3 calls/s and 100,000/day. Quota errors and query timeouts
can appear inside the response envelope. An operator should inspect the
envelope, page fixed historical ranges and deduplicate by chain ID, block hash
and log index when comparing results. Pagination, endpoint status and a
successful empty page describe what the service returned.
[V2 chain list](https://api.etherscan.io/v2/chainlist) · [Address logs](https://docs.etherscan.io/api-reference/endpoint/getlogs) · [Address and topics](https://docs.etherscan.io/api-reference/endpoint/getlogs-address-topics) · [Page cap](https://docs.etherscan.io/changelog) · [Rate limits](https://docs.etherscan.io/rate-limits) · [Errors](https://docs.etherscan.io/common-error-messages)

**Observed on 2026-11-18.** Four read-only Etherscan address-log requests used
the deployed Depository on each chain. First, with `page=1&offset=10`, the
deposit block and predecessor on each chain returned two logs each. All four
matched the retained funding receipts on address, height, block hash,
transaction hash, log index, topics and data. Ethereum indices 42 and 43
were at block `12,156,195`. Arbitrum indices 9 and 10 were at block
`330,178,730`. The first log on each chain recorded the respective
1,000,000 or 5,000,000 atomic-unit reserve. Then `page=1&offset=25` covered
each full saved-scan-to-deposit gap. The Ethereum query covered
`12,150,101–12,156,195` (6,095 blocks) and the Arbitrum query covered
`329,896,421–330,178,730` (282,310 blocks). Each returned two rows at one
candidate block with the expected log indices and event signatures. This
measures retrieval of known events for one address per chain. Whole-range
canonical comparison, other watched addresses and sustained throughput
remain unmeasured.
[Etherscan address-log API](https://docs.etherscan.io/api-reference/endpoint/getlogs) · [Retained funding receipts](../evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-publicjson) · [Saved scan evidence](../evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md#remaining-work-and-the-startup-budget)

RPC `eth_getLogs` takes a block range or a single `blockHash`, one emitting
address or an address array, and a positional topic filter. Across topic
positions criteria combine with AND, alternatives at one position combine
with OR, and `null` is a wildcard. Fixing `blockHash` removes height/fork
ambiguity for one query, including an empty result. Canonicality still comes
from XLN's chain observation. The RPC schema has no page cursor or universal
range/response limit. For example, Alchemy documents a 10-block free plan
query range and a 150 MB response ceiling, while Geth has its own configurable
range handling and local filter-map search. Inference for restore: an explorer
can do fewer remote calls for sparse searches, but RPC can itself be indexed.
Measure each endpoint and plan on the actual predicate. Etherscan's separate
`eth_getBlockByNumber` proxy is per block and provides no bulk range interface.
[Execution API](https://ethereum.github.io/execution-apis/api/methods/eth_getLogs/) · [EIP-234](https://eips.ethereum.org/EIPS/eip-234) · [Alchemy limits](https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-logs) · [Geth range filter](https://github.com/ethereum/go-ethereum/blob/master/eth/filters/filter.go) · [Etherscan block proxy](https://docs.etherscan.io/api-reference/endpoint/ethgetblockbynumber)

### Envio HyperSync and HyperRPC

Envio lists HyperSync on both testnets. The query API projects raw block,
transaction and log fields and can return all blocks through
`include_all_blocks`. The documented block fields include height, hash,
parent, bloom, roots and Arbitrum-specific metadata. Transaction fields
include hash, index, type, status, cumulative gas and receipt bloom. Log
fields include address, topics, data and positions. Continue until
`next_block` reaches the exclusive upper bound. Query time, response size
and soft row limits can end a page. The published block-field list omits
`requests_hash`, `block_access_list_hash` and `slot_number`, all relevant
to XLN's fork-aware hash check when present. Treat indexed block/transaction
rows as a candidate representation. Verify every required field and hash
on the target blocks, and require every transaction and every unfiltered log
before testing receipt reconstruction. Query calls require an API token.
[Supported networks](https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks) · [Query schema and pagination](https://docs.envio.dev/docs/HyperSync/hypersync-query) · [API tokens](https://docs.envio.dev/docs/HyperSync/api-tokens) · [XLN header fields](../../core/jurisdiction/adapter/rpc/state-anchor/rpc-header-hash.ts#L31)

An initial native HyperSync `/query` on 2026-11-18 used the existing HyperRPC
token and returned HTTP 403 with a product-access error. The dedicated
HyperSync token succeeded in the trials below.
[Token product access](https://docs.envio.dev/docs/HyperSync/api-tokens#token-limits-and-product-access) · [HyperSync pricing](https://envio.dev/pricing/hypersync)

#### Native HyperSync read-only trial

On 2026-11-18 an isolated reader used `include_all_blocks` and requested
transaction hashes and indices on Arbitrum Sepolia. It recomputed block
hashes with the XLN verifier, passed archive receipts through the canonical
receipt reader and queried HyperSync again for the complete second
observation. The outputs exactly matched the prior RPC range digests for
blocks 329,895,133–329,895,259 and 330,178,729–330,178,730, including one
and three watched logs respectively, and their proofs. The independently
recorded ordered transaction lists also matched at the original cursor and
the funding block.

Two linked windows then verified **4,094 blocks** from 329,895,133 through
329,899,226 in **26.876 s (152.3 blocks/s)**. Two header observations per
window used six HyperSync requests in total. The first window returned all 2,048
headers in one request per observation, including its predecessor. The
second needed 1,783 and 265 headers in two pages per observation, following
`next_block` with no gaps. The archive supplied 26 paced receipt replies.
There were no rate limits or timeouts in this sample.

Every observed HyperSync page cost 1,000 quota units, including the 128-header
and 2,048-header pages. A successful request at the start of one 60-second
window returned 14,000 remaining units after the 1,000-unit charge, consistent
with 15 such requests per minute on the tested token. The short trial
establishes compatibility and headroom for the sampled Arbitrum ranges.
It used an isolated transport feeding the same verifier. The gateway
follow-up uses the same ranges.
[Query pagination](https://docs.envio.dev/docs/HyperSync/hypersync-query#understanding-pagination) · [Canonical receipt reader](../../core/jurisdiction/adapter/receipt/reader.ts#L394)

#### Native HyperSync through the PoC gateway

On 2026-11-18, the standard read-only gateway ran on localhost under the
stand lease. The probe mapped the current Arbitrum upstream to a temporary
loopback adapter, which translated a complete header observation into
HyperSync `/query` pages. Archive receipts used the gateway's existing
history binding. Each observation issued a fresh query, including the
second observation after receipt verification. The test driver sent one
gateway batch per observation. The normal watcher transport still needs
an explicit range interface to use this mechanism from a Runtime.

All four tested ranges matched the independently recorded digests,
including the funding block. The two large linked windows verified
**4,094 blocks in 28.823 s (142.0 blocks/s)**. These windows used six
HyperSync pages and 26 archive receipt replies. Across all four ranges,
eight gateway header batches produced ten HyperSync pages and 28
archive receipt replies. There were zero upstream failures, rate limits
or client cancellations. The gateway exited cleanly. No operator Runtime
or store was opened. Ticket 12 still requires sustained catch-up and exact
restore of the original funded Runtimes.
[Gateway header path](../../jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts#L106) · [Ticket 12 acceptance criteria](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md#acceptance-criteria)

#### Configured watcher range transport

The PoC session can enable native range reads for the Arbitrum receipt
watcher, including its dispute-reference rebuild. The watcher calls the
gateway for each complete observation. HyperSync requests remain private
to the gateway. Both range passes use the existing header and receipt
verifier, and the old storage proofs use the archive binding.

On 2026-11-18 an isolated read-only driver used this configured transport
and the standard gateway for six consecutive windows of 2,047 blocks. The
final run verified **12,282 blocks** from 329,895,133 through 329,907,414 in
**99.590 s (123.3 blocks/s)**. All six window digests matched the preceding
run. A separate two-block window ending at the deposit matched the earlier
RPC result. Across both parts, HyperSync returned 18 pages and the archive
returned 92 receipt replies. The probe crossed a quota reset with zero
HTTP 429s. The longest window took 40.010 s with paced archive reads.

This measurement exercised the same receipt reader and gateway that the
watcher uses. Operator processes and WALs remained closed. Full catch-up
through the captured finality target and exact restore of the original
funded stores remain ticket 12 acceptance criteria.
[Session configuration](../runtime/usdc-poc-session.md#what-startup-verifies) · [Range RPC client](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-block-range.ts) · [HyperSync gateway reader](../../jurisdictions/scripts/usdc-cross-j-preflight/operators/hypersync-headers.ts)

#### Archive quota during the original Hub startup

The two archive bindings used the same Alchemy app key for Ethereum Sepolia
and Arbitrum Sepolia. The gateway paced receipts by URL at a one-second
interval per binding. During session `restore-DcdkjZ`, Ethereum receipt
requests received 62 replies and 12 HTTP 429s. Arbitrum received 25 replies
and 18 HTTP 429s. Both jurisdictions used their existing archive bindings
while the Arbitrum header requests used HyperSync.
[Gateway receipt dispatch](../../jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts#L172) · [Per-endpoint pacing](../../jurisdictions/scripts/usdc-cross-j-preflight/operators/read-pacing.ts)

Alchemy documents account-level throughput measured over rolling
ten-second windows. Its public method table lists `eth_getBlockReceipts`
at 20 usage CUs and 500 throughput CUs. Sustained simultaneous polling at
the configured per-URL pace can request about 1,000 throughput CU/s for
receipts alone. The advertised base Free tier offers 300 throughput CU/s.
That nominal Free budget would cover at most 0.6 such requests/s before
other account traffic. The current account's exact budget remains unverified.
The run reached 20 successful receipt requests in one observed ten-second
window, so it cannot establish the account tier or a fixed lower quota.
[Throughput policy](https://www.alchemy.com/docs/reference/throughput) · [Method costs](https://www.alchemy.com/docs/reference/compute-unit-costs) · [Published prices and capacity](https://www.alchemy.com/pricing)

After Hub stopped, one isolated repeat on each chain fetched the same blocks
seen in receipt retry logs. Ethereum returned 70 receipts for block
12,149,979 and Arbitrum returned four for block 329,897,247. Both returned
HTTP 200. Neither response contained numeric rate-limit metadata. The
organization Billing page shows the assigned throughput. A combined pace
for the shared quota or an independently budgeted receipt provider would
address contention. Historical `eth_getProof` remains an archive requirement.
[Alchemy organization throughput](https://www.alchemy.com/docs/dashboard-organizations#throughput) · [Receipt verification](../../core/jurisdiction/adapter/receipt/reader.ts#L394)

HyperRPC is Envio's separate read-only JSON-RPC interface and also lists both
testnets. Its advertised methods include `eth_getBlockByNumber` and
`eth_getBlockReceipts`, making it a plausible compatibility probe if existing
authorized access is available. Its docs specify a 500-method batch maximum,
50,000 logs per `eth_getLogs` query and a 150 MB response ceiling. The method
list omits `eth_getProof`, and block arguments do not accept the `safe` or
`finalized` tag. It needs a HyperRPC token. Envio says it recomputes the
transaction and receipt roots at ingestion. XLN verifies the data and
observes its own fence.
[HyperRPC methods and limits](https://docs.envio.dev/docs/HyperRPC/overview-hyperrpc) · [HyperRPC networks](https://docs.envio.dev/docs/HyperRPC/hyperrpc-supported-networks)

#### HyperRPC receipts on Ethereum Sepolia

On 2026-11-18 the existing HyperRPC token accepted one 64-call
`eth_getBlockReceipts` batch for blocks 12,149,977–12,150,040. It
returned 6,116 receipts in 9.857 s. The XLN reader verified receipts
against ethPandaOps headers for every bloom-positive block in the range
(54 of 64). A second 16-call batch took 0.694 s, returned 1,570 receipts,
and authenticated all 11 bloom-positive blocks in its range. Each batch
consumed one of the five HTTP requests available per minute in the
observed quota window. Both header observations used ethPandaOps.

At 16 calls per batch the HTTP quota allows up to 80 receipt blocks per
minute before retries, shared usage and window effects. The current watcher
fetches receipts one block per HTTP request. An explicit receipt-only
batch transport uses the existing HyperRPC token while historical
`eth_getProof` stays on Alchemy. The joint trial below measures throughput
after connecting that transport.
[Receipt reader](../../core/jurisdiction/adapter/receipt/reader.ts#L268) · [HyperRPC supported methods](https://docs.envio.dev/docs/HyperRPC/overview-hyperrpc#supported-methods)

The PoC gateway now supports a dedicated HyperRPC receipt transport on
Ethereum Sepolia. The watcher requests bloom-positive blocks in batches
of the configured size. The gateway spaces HyperRPC dispatches by 12.5 s.
The watcher verifies receipt counts, transaction positions, roots and proofs
through the existing verifier before its fresh header fence.

In the joint read-only trial, Ethereum verified **372 blocks in
146.308 s (153 blocks/min)**. Twelve HyperRPC batches returned receipts
for 333 blocks across quota windows, with zero observed rate limits.
A separate probe verified the existing 1 USDC Ethereum Hub funding event
through the same configured transport. Arbitrum verified **12,282 blocks
in 175.619 s (69.9 blocks/s)** during the joint trial. It received 16
successful HyperSync pages and 91 archive receipt replies. The 180 s probe
limit ended the run after six of eight planned Arbitrum windows.

The tested Ethereum pace exceeds its reference catch-up requirement.
Arbitrum reached about 70 blocks/s jointly, below the reference target
of about 81 blocks/s, with no 429s in the recorded replies. The isolated
Arbitrum rate of 123.3 blocks/s does not establish the joint recovery pace.
Both public operator stores stayed closed during these probes.
[Session settings](../runtime/usdc-poc-session.md#what-startup-verifies) · [Gateway receipt transport](../../jurisdictions/scripts/usdc-cross-j-preflight/operators/hyperrpc-receipts.ts)

#### Timing the Arbitrum pauses

The fixed range 329,897,180–329,899,226 reproduced the slowdown. It used
the same verified predecessor and matched the retained digest in every run.
The first joint run verified 2,047 blocks in 30.515 s. The next comparison
timed both complete observations through the standard gateway, with and
without two concurrent Ethereum receipt batches.

| Range timing | Arbitrum alone | Arbitrum with Ethereum |
| --- | ---: | ---: |
| Total | 31.599 s | 28.330 s |
| Both header observations | 17.183 s | 13.646 s |
| HyperSync response body reads, included above | 15.807 s | 12.284 s |
| Archive receipt phase | 14.171 s | 14.437 s |

HyperSync returned four successful pages in each run. JSON parsing took
8–12 ms in total. Each run received all 15 archive receipt replies, with
dispatches paced at about one second and no 429s. The largest archive
dispatch interval was 1.002 s in both runs. The slowest HyperSync page spent
8.3–8.9 s delivering its body after response headers arrived. The solo run
was also below the 81 blocks/s reference, so the comparison does not
attribute the extra delay to Ethereum. It localizes the variable delay to
obtaining HyperSync response bodies. Service-side streaming and network
transfer within that interval were not distinguished.

The existing receipt pacing accounts for about 14 s on this range. To meet
the reference rate, both header passes and remaining verification need to
fit in about 11 s.
[Reader and second observation](../../core/jurisdiction/adapter/receipt/reader.ts#L425) · [HyperSync client transport](https://docs.envio.dev/docs/HyperSync/hypersync-clients)

#### Comparing HyperSync JSON and Arrow

Two isolated trials used the same Arbitrum Sepolia range
329,897,180–329,899,226, predecessor 329,897,179, watch addresses and
one-second archive receipt dispatch interval. Both transports fed the same
XLN reader. A temporary adapter used Envio's Python client
`hypersync==1.3.0` and `get_arrow()` to read block and transaction
columns directly. The Arrow wall time includes the adapter's process
and row conversion overhead.

| Range timing | JSON | Raw Arrow |
| --- | ---: | ---: |
| Total | 35.319 s | 29.946 s |
| Authenticated blocks/s | 58.0 | 68.4 |
| Both header observations | 20.937 s | 15.581 s |
| Archive receipt phase | 14.140 s | 14.131 s |

Each run completed four HyperSync pages, validated all 15 archive receipt
responses, and matched the retained SHA-256 digest of the ordered reader
result (`41626e7680479403b2ed3661ac6452d289e8485684dc5d2d7b988a61b0d82a38`).
Both runs had zero observed 429s. Raw Arrow saved 5.373 s against this
JSON control. An earlier JSON trial finished in 28.330 s. Raw Arrow
verified this sample below the 81 blocks/s reference pace. Sustained
speed for the funded restore still requires a full run.
[Envio Arrow API](https://github.com/enviodev/hypersync-client-python/blob/main/hypersync/__init__.py)

The official Node.js client `@envio-dev/hypersync-client@1.4.1` returned
the first header pass in two upstream calls taking 1.096 s and 0.272 s.
The diagnostic adapter spent another 20 ms mapping those responses. XLN
rejected the predecessor header before requesting receipts because its
computed hash differed. The Node.js trial also had zero observed 429s.

An eight-header field comparison isolated the difference to `mixHash`
on every sampled block. The Node.js binding populates `mixHash` from
`transactions_root` in `Block::from_simple`. All eight raw Arrow
headers matched JSON field for field and reconstructed their hashes.
The Node.js binding requires a corrected mapping before it can be tested
for authenticated throughput. Both fresh observations used the existing
XLN hash check. The probe ran in a standalone read-only gateway with the
operator stores closed.
[Reproduction for Envio](envio-hypersync-node-mixhash-bug.md) · [Envio Node.js block mapping](https://github.com/enviodev/hypersync-client-node/blob/main/src/types.rs) · [XLN header reconstruction](../../core/jurisdiction/adapter/rpc/state-anchor/rpc-header-hash.ts)

#### Live Arbitrum Sepolia comparison

On 2026-11-18, chain ID 421614 and both header hashes verified at the original
Hub cursor (329,895,132) and funding block (330,178,730). The probe invoked
XLN's authenticated receipt reader directly with a 500 ms minimum gap between
header dispatches. All three runs over blocks 329,895,133–329,895,259
used the same archive for receipt data and produced identical headers,
authenticated logs and proofs.

| Header RPC | Calls per batch | Header requests for both passes | Time |
| --- | ---: | ---: | ---: |
| PublicNode | 32 | 8 | 4.182 s |
| HyperRPC | 32 | 8 | 3.607 s |
| HyperRPC | 128 | 2 | 0.676 s |

A follow-up used 128-call batches and kept the pacing across eight consecutive
pages. It linked each page to the preceding verified hash, starting from the
PublicNode-confirmed cursor hash. Both passes completed for all **1,016
blocks** through 329,896,148 in **8.220 s (123.6 verified blocks/s)**. The
probe used 16 header requests and four archive receipt requests. It observed
zero HTTP 429 responses and zero timeouts. A separate two-block test ending
at the funding block used HyperRPC for headers and receipts and matched the
PublicNode-plus-archive result, including the same three watched logs.

The 123.6 blocks/s sample covers the two header observations and receipt
verification during a short burst. The gateway follow-up below measures the
quota that limits sustained throughput on the current token.
[Reader and fence](../../core/jurisdiction/adapter/receipt/reader.ts#L394) · [Restore criteria](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md#acceptance-criteria)

#### Gateway follow-up and free-tier quota

The standard read-only gateway on localhost routed Arbitrum header requests
to HyperRPC and receipt requests to the existing archive. Hub and MM remained
stopped. With a 500 ms header interval and 128 calls per batch, the gateway
completed two 127-block pages before HyperRPC returned HTTP 429 on the fifth
header batch. With a 1,000 ms interval, an early retry found the quota still
exhausted at `eth_chainId`. After access returned, the same profile completed
one page before the fourth header batch returned HTTP 429. Every complete
page matched the direct probe. The gateway mapped upstream HTTP 429 to the
expected JSON-RPC availability code 503.
[Gateway transport](../../jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts#L106) · [Availability mapping](../../jurisdictions/scripts/usdc-cross-j-preflight/provider.ts#L12)

The owner confirmed HyperRPC's free-tier limit of five HTTP requests per
minute. A direct diagnostic in one quota window returned
`x-ratelimit-remaining` values of 3,000 after a scalar chain ID call, 2,000
after a 32-call batch, 1,000 after a 128-call batch and zero after a second
128-call batch. The next scalar returned HTTP 429. Each successful HTTP
request consumed the same quota increment in this sample.

At five requests per minute, two 128-call batches per page yield at most
about **5.3 verified blocks/s** (127 new blocks per page). This excludes
other header reads and delays. Even a hypothetical 500-call batch would
allow only about 20.8 blocks/s at the same HTTP quota. Both are below the
roughly 40 blocks/s needed just to reach the Arbitrum deposit within two
hours. The configured free tier establishes compatibility but lacks the
capacity for this restore. Ticket 12 remains open. Historical
`eth_getProof` remains a separate archive requirement.
[XLN batch limit](../../core/jurisdiction/adapter/rpc-utils.ts#L21) · [Startup budget](../evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md#remaining-work-and-the-startup-budget) · [HyperRPC batch limit](https://docs.envio.dev/docs/HyperRPC/overview-hyperrpc#limits-and-errors)

### SQD Portal

SQD documents `ethereum-sepolia` and `arbitrum-sepolia` datasets with block,
transaction and log rows. Both network pages show block hash, parent hash
and the three trie roots, plus raw logs and log/transaction positions. Its
general API reference also documents fields such as block `logsBloom`,
`requestsHash`, and transaction `logsBloom`, `type` and `cumulativeGasUsed`.
The dataset pages display fewer fields, and the general reference does not
list the Glamsterdam `blockAccessListHash` and `slotNumber` fields. Generic
field selectors therefore establish a probe list. Full headers and receipts
still require verification on each target range. Portal uses inclusive
`toBlock`. Request `includeAllBlocks: true` for contiguous headers, read all
required continuations and handle reorgs by checking the parent hash. Use
XLN's chain anchor and fence even when querying Portal's finalized stream.
[Ethereum Sepolia schema](https://docs.sqd.dev/en/data/evm/ethereum-sepolia) · [Arbitrum Sepolia schema](https://docs.sqd.dev/en/data/evm/arbitrum-sepolia) · [Portal fields and continuation](https://docs.sqd.dev/en/portal/evm/api) · [Finalized stream](https://docs.sqd.dev/en/api/evm/finalized-stream)

**Observed on 2026-11-18.** Four unauthenticated `/finalized-stream` requests
covered each confirmed deposit block and its predecessor (`12,156,194–12,156,195`
and `330,178,729–330,178,730`). Each chain got one request for number, hash,
parent hash, `receiptsRoot` and Depository logs, and one with block `logsBloom`
added. All four returned HTTP 403 with `error code: 1010` before any dataset
payload. This records an access failure from the execution host. Availability
of those fields on the selected blocks remains unverified.
[Portal endpoint](https://docs.sqd.dev/en/api/evm/finalized-stream) · [Recorded funding blocks](../evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md#remaining-work-and-the-startup-budget)

## Which part of restore can speed up

The 124.330 s Hub sample with the best recorded Arbitrum rate authenticated
124 Ethereum Sepolia blocks with 112 receipt replies and 16 logged header
sends. On Arbitrum Sepolia it authenticated 1,288 blocks with 8 receipt
replies and 161 logged header sends, including 3 HTTP 429s. Arbitrum added
130 new WAL scan blocks,
and both Entity-certified cursors stayed put. The official Arbitrum RPC
follow-up authenticated 1,010 blocks in roughly the same time, with 7
Arbitrum header HTTP 429s and no observed Arbitrum receipt 429s. These are
short runs, and the authenticated block count includes a rechecked WAL suffix.
[Raw comparison](../evidence/ts-usdc-cross-j-poc/hub-faster-profile-public.json) · [Official RPC follow-up](../evidence/ts-usdc-cross-j-poc/hub-official-arbitrum-rpc-public.json) · [Interpretation](../evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md)

Even with free, instantaneous receipts, the recorded Arbitrum header profile
dispatches at most `32 / 0.5 = 64` header methods/s. Two complete passes cap
authenticated progress at 32 blocks/s before range predecessors, retries or
audits. The 282,310 blocks remaining from the saved Hub scan to the deposit
require at least 564,620 header methods and about 2 h 27 min at that ceiling.
The two-hour launcher budget needs about 40 authenticated blocks/s just to
reach the deposit. Full restore also rechecks the saved suffix, scans to the
captured startup target and then starts MM with its own target and backlog.
Inference: speeding up header delivery or reducing contention can change this
bound. A filtered log lookup alone leaves both header passes in the cost.
[Throughput calculation and startup sequence](../evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md#remaining-work-and-the-startup-budget) · [Receipt range fence](../../core/jurisdiction/adapter/receipt/reader.ts#L446)

There are two useful roles for indexes under the current checks. Use filtered
results to locate known events, compare provider visibility, or prioritize
bounded prefetch of full receipt blocks from ranges the watcher already needs.
Give speculative reads a fixed budget so empty or noisy hints cannot consume
the current scan's capacity. A bulk source can also supply complete blocks
and receipts for local verification, with every height checked, the same
expected-parent chain and a fresh second observation of the entire range
after receipt authentication. That can cut HTTP fan-out or spread provider
load. Keep transaction order, receipt root, exact event order, authority
admission and historical storage audits. Data availability, reconstruction
and sustained gains are unmeasured. [Deferred transport candidates](../runtime/rpc-catchup-optimization.md) · [XLN receipt reader](../../core/jurisdiction/adapter/receipt/reader.ts) · [Watcher admission](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-ingress.ts#L194)

## Narrowing the authenticated bloom test

For the current decoder, a conservative predicate reads receipts if the
authenticated bloom may contain the Depository or EntityProvider address,
or if it may contain a registered ERC-20 address **and** either the `Transfer`
or `Approval` signature. A missing required bloom element proves that branch
cannot match. Present bits can come from different logs, so still verify all
receipts on every positive block. Keep the two XLN contract branches
address-only. Their decoder sees all contract logs, including decode failures.
Keep the registered token set and use raw topic membership for the ERC-20
branch so a malformed recognized signature still reaches the fail-loud
decoder. Measure how often the extra signature test turns a current positive
into a negative on real history. [Geth bloom implementation](https://github.com/ethereum/go-ethereum/blob/master/core/types/bloom9.go) · [Watch addresses](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-ingress.ts#L174) · [Decoder policy](../../core/jurisdiction/adapter/rpc-watcher-events.ts#L159)

An owner-aware bloom predicate is more selective in principle. A valid
tracked `Transfer` includes a tracked sender or recipient and a valid
tracked `Approval` includes the tracked owner. Those topics are 32-byte
ABI-encoded addresses. The block bloom only answers value membership and
cannot distinguish topic position. The present decoder parses recognized
signatures before applying owner, allowance and balance cursors. A malformed
recognized event can fail decoding even without a valid owner topic. An
owner-negative bloom can therefore hide an existing rejection. Prove that
malformed handling, dynamic watch admission and wallet cursors stay equivalent
before allowing any owner-based skip. Per-owner association queries are
already suitable for diagnostic hints. [Solidity indexed event encoding](https://docs.soliditylang.org/en/latest/abi-spec.html#events) · [Geth bloom implementation](https://github.com/ethereum/go-ethereum/blob/master/core/types/bloom9.go) · [Wallet projection and decoder](../../core/jurisdiction/adapter/rpc-watcher-events.ts#L90) · [Signer import fence](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-ingress.ts#L247)

## What a trustless index would need

A verifier needs a commitment tied to the accepted chain and a proof that
covers the exact range and filter. It must validate the range boundaries,
derive the rows or key intervals needed for the filter, verify candidates
and prove the gaps or exclusions. EIP-7745 is a draft example. It proposes
replacing the header bloom with a committed Merkle `LogIndex`. A remote prover
would prove both block boundaries, all filter rows needed over that interval
and each possible matching entry against the same root. Geth's local filter
maps improve search time and currently return ordinary RPC log rows.
[EIP-7745 remote prover](https://eips.ethereum.org/EIPS/eip-7745#safe-access-with-a-remote-prover) · [Geth local index](https://github.com/ethereum/go-ethereum/blob/master/eth/filters/filter.go)

The related draft EIP-8304 keeps the header bloom and commits sorted index
table roots in a system contract. A complete query would need coverage by
table proofs plus inclusion evidence for the corresponding logs. EIP-7792,
marked Stagnant, proposes proving before and after accumulator values at the
query boundaries. The current Hegotá meta-EIP lists EIP-8304 as declined and
leaves activation dates blank.
Glamsterdam's Sepolia activation list includes neither EIP-7745 nor EIP-8304.
The sampled XLN ranges on both chains authenticated bloom-bearing headers,
and the public Arbitrum Sepolia chain is a separate Nitro rollup. No reviewed
source establishes deployed, usable query completeness proofs on either
network for these historical blocks. [EIP-8304](https://eips.ethereum.org/EIPS/eip-8304) · [EIP-7792](https://eips.ethereum.org/EIPS/eip-7792) · [Hegotá meta-EIP source](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-8081.md#declined-for-inclusion) · [Glamsterdam meta-EIP](https://eips.ethereum.org/EIPS/eip-7773) · [Arbitrum chain info](https://docs.arbitrum.io/chain-info) · [XLN measured ranges](../evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md)

## Bounded read-only comparison

1. Pin the chain ID, candidate, watch addresses and cursor inputs. Use a
   127-block window from just above each original certified cursor, another
   around each retained deposit block, and an Ethereum receipt-heavy sample.
   Record the independently observed predecessor and end hashes. Reuse
   existing reads or captured data, run one chain and variant at a time, and
   keep each trial to 60 seconds. Report access, schema or baseline failures
   as incomplete comparisons. The report's Portal probe only tested access.
   [Known cursors and blocks](../evidence/ts-usdc-cross-j-poc/rpc-catchup-results.md#remaining-work-and-the-startup-budget)
2. For A, run the current reader in isolation with the existing header and
   receipt bindings. For B, first compare index hits to A outside ingress.
   Record missed or extra raw logs, binding each to chain, block hash,
   transaction index and log index, with topics and data checked exactly.
   Test one source change at a time. First try bulk first-pass headers with
   A's receipts, then full receipt data with A's headers if the provider has
   all fields. Run the existing full second pass fresh over RPC after receipt
   work in every variant. As a separate local comparison, recompute both bloom
   predicates from A's authenticated headers and count receipt reads avoided.
   [Current verification boundary](../../core/jurisdiction/adapter/receipt/reader.ts#L394)
3. Require identical header hashes, parent continuity and receipt roots,
   ordered raw authenticated logs and ordered watcher events with equivalent
   proof verification and admission. On captured data, remove a header, a
   transaction or log, swap a fork hash, and omit one event from the hint
   response. The authenticated read should reject incomplete or conflicting
   required data and return the same events when only a hint is missing. Keep
   finality, state audits, dispute references and WAL/outbox ordering in the
   eventual production path. This comparison uses disposable read results or
   immutable copies and leaves Runtime stores unopened. [Receipt validation](../../core/jurisdiction/adapter/receipt/reader.ts#L203) · [Watcher admission](../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-ingress.ts#L194) · [Ticket 12 restore criteria](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md#acceptance-criteria)
4. Compare useful authenticated blocks/s, wall time by pass, method calls,
   HTTP requests, wire bytes, queue waits, retries, 429s, positive blooms,
   receipt reads and proof construction time. Report whether full headers
   reconstructed on each chain and how Ethereum receipt work changed. A
   bounded trial establishes only sample parity and speed. Ticket 12 still
   needs the original funded catch-up and exact recovery through the owning
   checks. Keep this investigation off the demo's execution path.
   [Measurement guidance](../runtime/rpc-catchup-optimization.md#validation-when-an-idea-is-selected) · [Fresh demo scope](../runtime/usdc-poc-fresh-demo.md#before-the-public-demo)
