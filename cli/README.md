# xln CLI wallet

In-process terminal wallet for xln. Mirrors the frontend account workspace
(open / pay / receive / swap / move / lending / history / manage) without the
landing page or 3D graph.

## Quick start

```bash
# from repo root
bun cli/xln.ts onboard
bun cli/xln.ts          # interactive TUI
bun run xln -- status
```

## Orchestration tests

Uses the same stack boot as `local-prod-smoke`:
`local-test-port-lease` → `scripts/start-anvil.sh` → `scripts/start-anvil2.sh` → `scripts/start-server.sh`.

```bash
bun run test:cli:orchestration
```

## Commands

| Command | Purpose |
|---|---|
| `xln` | Interactive wallet TUI |
| `xln onboard` | Demo / mnemonic / BrainVault identity |
| `xln status` | Accounts + capacity bars |
| `xln hubs` | Discover hubs (`/api/hubs` + local gossip) |
| `xln open <hub>` | Open hub account |
| `xln pay <to> <amt>` | Direct / trusted / HTLC payment |
| `xln receive` | Invoice / deep link |
| `xln swap …` | Place same-j swap offer |
| `xln move r2c\|r2r\|r2e` | Reserve moves |
| `xln lend …` | Lending offer/borrow/repay |
| `xln settings --bars twin` | Closed vs twin ASCII bars |
| `xln daemon` | Unix-socket daemon for agents |

## Bars

- `closed` — canonical `deriveDelta().ascii` (`-` credit, `=` collateral, `|` delta)
- `twin` — out/in shells like the frontend capacity bar

```bash
xln settings --bars twin
```

## Mainnet / testnet

Defaults to `https://xln.finance` for `/api/jurisdictions` and `/api/hubs`
(same sources as the frontend). Relative RPC paths like `/rpc` resolve against
`XLN_API_BASE`.

Fresh `importJ` requires an RPC that can serve
`entityProviderDeploymentBlock` history (archive). Pruned public RPCs fail loud:

```text
RPC_ENTITY_PROVIDER_DEPLOYMENT_ORIGIN_UNAVAILABLE
```

Use a local mesh for development:

```bash
# terminal A
bun run serve

# terminal B
export XLN_API_BASE=http://127.0.0.1:8080
bun cli/xln.ts onboard --mode demo
bun cli/xln.ts
```

Production / mainnet:

```bash
export XLN_API_BASE=https://xln.finance
```

## Agent / shared daemon

```bash
xln daemon                 # holds in-process runtime + ~/.xln/daemon.sock
xln pay 0x… 1 --token 1    # routes via daemon when socket exists
xln pay 0x… 1 --local      # force one-shot in-process session
```

Wallet secrets live encrypted in `~/.xln/wallet.json`. Runtime DB under `~/.xln/db` (or `XLN_DB_PATH`).
