# Runtime Machine

[Up: runtime map](./overview.md) | [Down: entity machine](./entity.md) | [Storage](./storage.md) | [Networking](./networking.md)

The R-machine is the outer deterministic coordinator. It owns runtime input admission, one serialized processing loop, explicit scheduled wakes, entity replica routing, output delivery, and the durable commit boundary. Infrastructure may wake or transport the machine, but must not mutate consensus state directly.

## Source

- [`core/runtime.ts`](../../core/runtime.ts) - public facade and orchestration entrypoint.
- [`core/runtime/`](../../core/runtime) - small R-machine policies extracted from the facade.
- [`core/runtime/mempool/input-queue.ts`](../../core/runtime/mempool/input-queue.ts) - deterministic input queue.
- [`core/runtime/delivery/topology/output-routing.ts`](../../core/runtime/delivery/topology/output-routing.ts) - durable output planning and retry.
- [`core/storage/`](../../core/storage) - persistence implementation.

## Main Methods

- `process(env, inputs, delay)` - executes one runtime transition and commits before side effects.
- `enqueueRuntimeInput(env, input)` - admits ordered external work into the runtime queue.
- `startRuntimeLoop(env)` / `resumeRuntimeLoop(env)` - own the single loop lifecycle.
- `createEmptyEnv(seed)` - creates deterministic initial runtime state.
- `saveEnvToDB(env)` / `loadEnvFromDB(...)` - persist and restore replayable state.
- `generateHookPings(...)` - converts due canonical jobs into explicit entity inputs.

## Invariant

Only the R-machine advances runtime height. P2P, timers, UI, and server handlers submit inputs; they never create frames independently.
