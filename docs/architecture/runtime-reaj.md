# Runtime REAJ Architecture

XLN runtime state is organized as `Runtime -> Entity -> Account -> Jurisdiction`.

Runtime is the outer coordinator. It owns J-replicas, E-replicas, input queues, output routing, persistence, P2P lifecycle, and deterministic timestamps.

Entity is the BFT state machine. It owns accounts, proposals, votes, J-batch accumulation, and profile state. Entity frames are signed by validator threshold.

Account is the bilateral 2-of-2 state machine. It owns token deltas, locks, swaps, pulls, credit limits, frame hashes, ACKs, and dispute metadata.

Jurisdiction is the settlement layer. It owns on-chain reserves, collaterals, contract events, and final settlement truth.

Execution flow:

1. External action enters as `RuntimeInput`.
2. Runtime routes `EntityInput` to the target entity replica.
3. Entity applies `EntityTx`. Its `accountInput` variant carries the exact
   child `AccountInput`; Entity-owned financial transactions create a local
   `AccountTx[]` admission instead of fabricating another input type.
4. The Account machine applies `AccountInput` variants
   `frame/ack/ack_frame/dispute/board_hanko_refresh`. Local AccountTx admission
   and finalized jurisdiction evidence enter the same `applyAccountInput`
   transition but never enter the `EntityTx.accountInput` wire branch.
5. Entity queues J batches for jurisdiction settlement.
6. J events are observed, authenticated, and folded back into entity/account state.

Naming conventions:

- `height` is the frame/block height. Do not introduce `frameId`.
- `tx` means a requested state transition. Do not rename these to `transition`.
- `AccountInput` means an input to the Account replica. Its local `txs` branch
  is never sent to the peer; the other variants are bilateral protocol
  messages.
- Replay protection is the frame chain (`height + prevFrameHash`) and signed hankos. On-chain nonces are only for settlement ordering.

Runtime machine types live at `core/runtime/types.ts`. Entity and Account
types belong to their owner folders. Import from the owner directly; a neutral
root barrel would hide the Runtime → Entity → Account cascade.
