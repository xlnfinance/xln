# XLN Debates

Standalone application-layer MVP for `debates.xln.finance`.

## Run

```bash
cd debates
DEBATES_DEV_MODE=1 DEBATES_OFFLINE_XLN=1 bun server.ts
```

Open `http://127.0.0.1:8097`.

## Test

```bash
cd debates
bun run check
bun run test:e2e
```

The e2e test starts its own server and SQLite database, then runs a complete paid debate flow:

1. creator funds a dev balance;
2. creator opens a paid challenge;
3. counterparty funds and accepts;
4. both sides complete three rounds;
5. placeholder judge board finalizes the verdict;
6. winner withdraws to a mock XLN entity.

## XLN Integration Points

The service mirrors the custody service flow:

- signed login: `/api/auth/challenge` and `/api/auth/verify`;
- deposit instructions: `/api/deposit/instructions`;
- deposit crediting: `get_frame_receipts` scans `HtlcReceived` and credits `uid:<userId>` exactly once;
- withdrawal: `/api/withdraw` runs `find_routes`, reserves balance, calls `queue_payment`, and finalizes/restores from `HtlcFinalized` / `HtlcFailed`;
- service env:
  - `DEBATES_ENTITY_ID`
  - `DEBATES_SIGNER_ID`
  - `DEBATES_JURISDICTION_ID`
  - `DEBATES_DAEMON_WS`
  - `DEBATES_DAEMON_AUTH_SEED`
  - `DEBATES_DAEMON_AUTH_AUDIENCE`

`DEBATES_OFFLINE_XLN=1` finalizes withdrawals locally for development. Without that flag and with daemon auth env present, Debates uses the real XLN daemon path.

## Local AI

Debates judge boards default to the local XLN AI server:

```bash
bun ai/server.ts
```

The default model is `gemma3-27b-mlx`, configurable with:

```bash
DEBATES_AI_SERVER_URL=http://127.0.0.1:3031
DEBATES_AI_MODEL=gemma3-27b-mlx
DEBATES_AI_FALLBACK=0
```

With fallback enabled, the app still completes the flow if the local model is unavailable. With `DEBATES_AI_FALLBACK=0`, judging fails hard unless the local model returns valid JSON.
