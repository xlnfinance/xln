# Frontend Lib Map

The frontend is large enough that the immediate win is boundary clarity, not another component explosion.

## Main buckets

- `components/`: user-facing UI panels and shared widgets
- `stores/`: runtime/session/settings/view state
- `utils/`: pure helpers and formatting logic
- `types/`: frontend-facing type declarations
- `view/`: panel workspace / 3D view system
- `network3d/`: 3D network rendering helpers

## Current consolidation priorities

1. Keep payment behavior logic out of giant Svelte files.
Main target:
- `components/Entity/PaymentPanel.svelte`

2. Keep gossip refresh behavior centralized.
Main targets:
- entity selectors
- naming/fetch-on-miss helpers

3. Keep account delta rendering shared.
Do not maintain separate formatting logic for:
- list rows
- detail panels
- settlement views

## Cleanup rule

Only remove components after proving:
- no imports
- no route usage
- no dynamic or embed usage

For now, document likely candidates first and delete only the proven dead files.
