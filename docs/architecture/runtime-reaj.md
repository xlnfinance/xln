# Runtime REAJ Architecture

XLN runtime state is organized as `Runtime -> Entity -> Account -> Jurisdiction`.

Runtime is the outer coordinator. It owns J-replicas, E-replicas, input queues, output routing, persistence, P2P lifecycle, and deterministic timestamps.

Entity is the BFT state machine. It owns accounts, proposals, votes, J-batch accumulation, and profile state. Entity frames are signed by validator threshold.

Account is the bilateral 2-of-2 state machine. It owns token deltas, locks, swaps, pulls, credit limits, frame hashes, ACKs, and dispute metadata.

Jurisdiction is the settlement layer. It owns on-chain reserves, collaterals, contract events, and final settlement truth.

Execution flow:

1. External action enters as `RuntimeInput`.
2. Runtime routes `EntityInput` to the target entity replica.
3. Entity applies `EntityTx` and may emit account inputs or J inputs.
4. Account applies `AccountTx` inside a signed bilateral frame.
5. Entity queues J batches for jurisdiction settlement.
6. J events are observed, authenticated, and folded back into entity/account state.

Naming conventions:

- `height` is the frame/block height. Do not introduce `frameId`.
- `tx` means a requested state transition. Do not rename these to `transition`.
- Replay protection is the frame chain (`height + prevFrameHash`) and signed hankos. On-chain nonces are only for settlement ordering.

The type barrel at `runtime/types.ts` should stay navigable. Put new domain-specific types under `runtime/types/*` and re-export them from the barrel only for compatibility with existing imports.
