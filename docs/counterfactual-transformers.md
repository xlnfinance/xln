# custom transformer tooling

Owner decision, 2026-10-17: arbitrary custom-contract financial admission is unavailable.
The canonical Studio bounded dispute-gas guard remains mandatory.

React Manage → Custom Contracts provides an ephemeral source lab: templates,
Solidity compilation and ABI parameter preview. The compiler is pinned to solc
0.8.36+commit.8a079791 with no version fallback. Preview execution is tooling;
it cannot authorize Account state changes or predict a future dispute outcome.

The laptop experiment's propose/approve/resolve mutation path, durable initcode,
source/compiler/schema fields, custom dispute arguments and CREATE2 factory have
been retired. Unsupported Account subcontract_transition and Entity customContract
inputs receive typed admission rejection before their payload is interpreted.
Old persisted formats are rejected and testnet data must be regenerated.
There is no migration or old-format reader.

Current Studio signed evidence retains its existing subcontract representation,
proof construction, allowance bounds and dispute finality. Current-format checkpoint
plus ordered WAL recovery remains unchanged. This integration does not claim feature
parity with the retired arbitrary-contract experiment.
