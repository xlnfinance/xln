# Native exit and unsigned deployment evidence

Base: `2f1ac7efcaa2f8395d9c8b2f4da5b3b2d3a6fb36`. This is bounded financial and deployment evidence; full release and mainnet acceptance remain outstanding. See `proof.json` for exact commands, source hashes, counts and preserved failed attempts.

The existing native TVM Cross scenario restored the accepted two-direction credit swaps. A separate fixture then converted the received credit claim through actual token funding, reserve deposit, collateral and automatic signed withdrawal. The recipient received 10,000,000 atomic test tokens; reserves, collateral and continuations ended at zero. Cold recovery preserved both Runtime anchors and all four Account pairs without resubmission. Live and recovery passed 2/2 in 74.594 and 38.673 seconds. This used private JavaTRON and test tokens, not public issuer USDT.

`prepareTronContract` shares the existing canonical deployer's linker and transaction builder. It builds unsigned bytes using a public owner and optional explicit TAPOS; signing remains in the deployer after its prepared-transaction identity check. L1 passed 17 tests and 125 assertions. L2 reproduced all 8 historical native deployment txIDs, raw bytes and addresses exactly, without a signature or broadcast.

The Nile node successfully simulated all 8 linked creation inputs: 17,664,767 energy at 100 SUN/energy, or 1,766.4767 test TRX for creation energy alone. Bandwidth, stack binding, token registration and subsequent financial execution are not included. These estimates do not establish runtime behavior against the planned dependencies. The unsigned planning packet's TAPOS expires; rebuilding it changes the linked addresses.

Public Nile still rejects the configured old EntityProvider at `shareDepository()`. The dedicated test addresses lack funds, and the official faucet did not load in a real Studio browser. No CAPTCHA, funding rejection, funding receipt or public deployment was observed. The designated mainnet signer remains unknown.

For native-stand child commands under Bun 1.4.3, pass `-- -- bun <driver>`: Bun consumes the first separator. Verify the driver's required output artifact, not just the enclosing process exit.
