# XLN Debates Megaprompt

## Mission

Build **XLN Debates**: a polished external service at `debates.xln.finance` where users sign in with XLN, fund a service balance through XLN payments, create paid or free debate challenges, invite a counterparty by link, attach context, choose an AI judge board, run a fixed number of rounds, and automatically pay the winner back to their XLN wallet.

This is not a generic chat app. It is the first serious application layer on top of XLN:

- XLN provides identity, deposits, escrow accounting, routing, and withdrawals.
- The Debates service provides challenge orchestration, public pages, transcript integrity, AI judging, and payouts.
- AI providers can be temporary placeholders for MVP, but the architecture must be ready for OpenRouter or any OpenAI-compatible provider.

The result should feel like a financial terminal crossed with a premium debate arena: dense, fast, credible, animated, and public by default.

## Existing XLN Code To Reuse

Read these first:

1. `readme.md`
2. `docs/intro.md`
3. `docs/custody.md`
4. `docs/implementation/payment-spec.md`
5. `custody/server.ts`
6. `custody/store.ts`
7. `custody/daemon-client.ts`
8. `runtime/radapter/auth.ts`
9. `runtime/jadapter/default-tokens.ts`
10. `ai/server.ts`

Useful existing pieces:

- `custody/server.ts`: template for an external Bun service with sessions, deposits, withdrawals, token formatting, daemon access, and static UI.
- `custody/store.ts`: SQLite ledger pattern for balances and activity.
- `custody/daemon-client.ts`: `getFrameReceipts`, `findRoutes`, `queuePayment`.
- `runtime/radapter/auth.ts`: capability-token auth between service and runtime daemon.
- `runtime/jadapter/default-tokens.ts`: dev/test token catalog: USDC, WETH, USDT.
- `ai/server.ts`: existing council orchestration that can inspire judge-board execution.

Do not mutate custody directly. Create a new service directory:

```text
debates/
  server.ts
  store.ts
  ai.ts
  static/
    index.html
    app.js
    styles.css
```

## Product Name

Public name: **XLN Debates**

Codename: **debates**

Primary domain: `debates.xln.finance`

Avoid making `arb` the public name for now. `arb` can become a later high-stakes arbitration mode, but `debates` is broader and safer: free debates, prize challenges, paid escrow debates, model battles, tournaments, public reasoning archives.

## Core User Flow

### 1. Sign In With XLN

User lands on `debates.xln.finance`.

They see a focused app screen, not a marketing landing page.

Auth options:

- MVP fallback: anonymous session cookie like custody service.
- Target: XLN signed login.

Target login flow:

1. Server creates nonce:
   - `GET /api/auth/challenge`
   - returns `{ nonce, message, expiresAt }`
2. User signs message with XLN wallet/signer.
3. Client submits:
   - `POST /api/auth/verify`
   - `{ entityId, signerId, signature, nonce }`
4. Server validates and creates session bound to:
   - `userId`
   - `entityId`
   - `signerId`
   - `createdAt`
   - `lastSeenAt`

If XLN signed login is not available yet, implement the DB/session interfaces now and mark the signature verifier as a replaceable adapter.

### 2. Deposit Through XLN

The Debates service has a custody/debate entity:

- `DEBATES_ENTITY_ID`
- `DEBATES_SIGNER_ID`
- `DEBATES_JURISDICTION_ID`
- `DEBATES_DAEMON_WS`
- `DEBATES_DAEMON_AUTH_SEED`
- `DEBATES_DAEMON_AUTH_AUDIENCE`

The deposit flow should mirror custody:

1. User chooses token: USDC or USDT first.
2. UI shows a deposit instruction / QR / deep link.
3. User pays `DEBATES_ENTITY_ID` through XLN.
4. Service polls frame receipts through daemon:
   - `getFrameReceipts`
   - eventNames: `HtlcReceived`, `HtlcFinalized`, `HtlcFailed`
5. On `HtlcReceived`, parse `uid:<userId>` from description and credit balance exactly once.

Ledger states:

- `available`: can be spent or locked into a challenge.
- `locked`: committed to active challenge escrow.
- `spent`: paid for inference/platform fees.
- `withdrawable`: won funds ready to withdraw. For MVP this can be the same pool as `available`, but keep the schema ready to separate it.

### 3. Create A Challenge

User clicks a strong primary command: **New Debate**.

Challenge creation form must include:

- Statement:
  - Example: `Linux is better than Windows for professional developers.`
- Side A position:
  - Pro / affirmative.
- Side B position:
  - Con / negative.
- Stake:
  - `0` for free challenge.
  - Positive amount for escrow challenge.
- Token:
  - USDC or USDT.
- Number of rounds:
  - 1, 3, 5, 7, custom max 10.
- Per-message limit:
  - characters and/or tokens.
- Time limit per turn:
  - optional for MVP, schema required.
- Context attachments:
  - text blocks, URLs, uploaded files later.
  - MVP: text context only.
- Judge board:
  - select 3, 5, or 7 judges.
  - each judge has model/provider/persona/weight.
- Rules:
  - predefined template plus custom additions.
- Visibility:
  - public, unlisted, private.
- Payout rule:
  - winner takes all.
  - split on draw.
  - creator-funded prize.
  - no payout for free debates.

On create:

- Validate funds if stake > 0.
- Lock creator stake if creator-funded or symmetric escrow starts immediately.
- Generate invite link:
  - `/c/:challengeSlug`
  - tokenized join URL if unlisted/private.
- Challenge enters `waiting_for_counterparty`.

### 4. Counterparty Accepts

Counterparty opens invite link.

They see:

- statement;
- side assignment;
- stake requirement;
- rules;
- judge board;
- number of rounds;
- current context;
- public/private visibility;
- exact payout rule.

They can:

- accept and lock matching stake;
- decline;
- request changes if negotiation mode is enabled later.

On accept:

- lock required funds;
- status becomes `active`;
- round 1 begins;
- public challenge page updates live.

### 5. Debate Rounds

The debate is turn-based.

Round shape:

```text
Round 1
  A opening
  B response

Round 2
  A rebuttal
  B rebuttal

...

Final round
  A closing
  B closing
```

Rules:

- enforce character/token limits server-side;
- freeze every submitted message;
- record timestamp, author side, session/user/entity;
- no editing after submission;
- public page should show transcript as an immutable timeline.

### 6. Judge Board Verdict

After final message:

1. Debate becomes `judging`.
2. Server creates a canonical judge packet:
   - statement;
   - side definitions;
   - rules;
   - context;
   - full transcript;
   - payout rule;
   - judge instructions.
3. Each judge runs independently.
4. Each judge must return strict JSON.
5. Aggregator computes final verdict.
6. Verdict is published.
7. Funds are released.

Judge JSON:

```json
{
  "winner": "A",
  "confidence": 0.82,
  "scores": {
    "A": 87,
    "B": 73
  },
  "criteria": {
    "logic": { "A": 9, "B": 7 },
    "evidence": { "A": 8, "B": 6 },
    "rebuttal": { "A": 9, "B": 7 },
    "clarity": { "A": 8, "B": 8 },
    "rule_compliance": { "A": 10, "B": 9 }
  },
  "ruleViolations": [],
  "reasoning": "Short but specific reasoning here.",
  "decisiveMoments": [
    {
      "round": 3,
      "side": "A",
      "summary": "A directly answered the strongest objection and tied it to the context."
    }
  ]
}
```

Aggregator output:

```json
{
  "winner": "A",
  "method": "majority",
  "judgeCount": 5,
  "votes": { "A": 4, "B": 1, "draw": 0, "invalid": 0 },
  "confidence": 0.78,
  "payout": {
    "tokenId": 1,
    "winnerAmountMinor": "198000000000000000000",
    "platformFeeMinor": "2000000000000000000",
    "inferenceFeeMinor": "0"
  },
  "summary": "A wins by stronger rebuttal quality and better use of shared context."
}
```

### 7. Winner Payout

After final verdict:

- release locked escrow;
- credit winner balance;
- record fees;
- expose **Withdraw to XLN Wallet**.

Withdrawal flow:

1. Winner enters target XLN `entityId`.
2. Server calls daemon `findRoutes`.
3. Server reserves balance.
4. Server calls `queuePayment` with mode `htlc`.
5. Server finalizes or restores balance based on `HtlcFinalized` / `HtlcFailed`.

This should mirror custody withdrawal behavior.

## MVP AI Provider

Implement provider abstraction now:

```typescript
interface DebateJudgeProvider {
  judge(input: JudgeInput, judge: JudgeConfig): Promise<JudgeVerdict>;
}
```

Provider modes:

1. `placeholder`
   - deterministic local fake judge.
   - useful for UI/dev/tests.
   - must produce realistic JSON.
2. `local-council`
   - calls existing `ai/server.ts` or local Ollama/MLX endpoint.
3. `openrouter`
   - future OpenRouter-compatible API.
   - environment variables:
     - `OPENROUTER_API_KEY`
     - `OPENROUTER_BASE_URL`
     - `OPENROUTER_SITE_URL`
     - `OPENROUTER_APP_NAME`

Do not hardcode OpenRouter into the business logic. Judges are configured records.

## Database Schema

Use SQLite for MVP, following custody style.

Required tables:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  entity_id TEXT,
  signer_id TEXT,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE balances (
  user_id TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  available_minor TEXT NOT NULL,
  locked_minor TEXT NOT NULL,
  spent_minor TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, token_id)
);

CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  delta_available_minor TEXT NOT NULL,
  delta_locked_minor TEXT NOT NULL,
  delta_spent_minor TEXT NOT NULL,
  reason TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE deposits (
  event_key TEXT PRIMARY KEY,
  user_id TEXT,
  token_id INTEGER NOT NULL,
  amount_minor TEXT NOT NULL,
  description TEXT NOT NULL,
  from_entity_id TEXT NOT NULL,
  hashlock TEXT NOT NULL,
  frame_height INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at_ms INTEGER
);

CREATE TABLE withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  amount_minor TEXT NOT NULL,
  requested_amount_minor TEXT NOT NULL,
  fee_minor TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  hashlock TEXT,
  route_json TEXT,
  frame_height INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finalized_at INTEGER,
  daemon_error TEXT,
  started_at_ms INTEGER
);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  created_by_user_id TEXT NOT NULL,
  side_a_user_id TEXT,
  side_b_user_id TEXT,
  statement TEXT NOT NULL,
  side_a_label TEXT NOT NULL,
  side_b_label TEXT NOT NULL,
  status TEXT NOT NULL,
  visibility TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  stake_minor TEXT NOT NULL,
  payout_rule TEXT NOT NULL,
  rounds_total INTEGER NOT NULL,
  current_round INTEGER NOT NULL,
  message_limit_chars INTEGER NOT NULL,
  turn_time_limit_sec INTEGER,
  invite_token TEXT,
  rules_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  judge_board_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  started_at INTEGER,
  judging_started_at INTEGER,
  finalized_at INTEGER
);

CREATE TABLE challenge_locks (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  amount_minor TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE TABLE debate_messages (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  side TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  chars_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE judge_runs (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  judge_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  verdict_json TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE verdicts (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  winner TEXT NOT NULL,
  method TEXT NOT NULL,
  votes_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  payout_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

All money moves must go through ledger helpers. Never update balance columns ad hoc from route handlers.

## API Surface

Implement clean JSON endpoints:

```text
GET  /api/me
POST /api/reset-session

GET  /api/auth/challenge
POST /api/auth/verify

GET  /api/deposit/instructions?tokenId=1
GET  /api/qr?data=...
POST /api/withdraw

GET  /api/challenges
POST /api/challenges
GET  /api/challenges/:slug
POST /api/challenges/:slug/accept
POST /api/challenges/:slug/messages
POST /api/challenges/:slug/judge

GET  /api/public/challenges
GET  /api/public/challenges/:slug
```

Route behavior:

- all mutation endpoints require a session;
- paid challenge creation checks funds;
- accept checks funds;
- message submission checks status, side, turn, round, and limit;
- judge can be triggered automatically when transcript is complete;
- public endpoints never leak private session fields.

## Public Pages

The app must include:

### Home / Arena

First screen is the product itself:

- left rail: balance, active challenges, create button;
- center: public debate feed;
- right rail: judge boards, top verdicts, recent payouts;
- no fake marketing hero.

### Challenge Page

Public challenge page:

- title/statement;
- live status;
- stake and token;
- sides A/B;
- round progress;
- transcript;
- context drawer;
- judge board;
- verdict panel when finalized;
- payout transaction state.

### Create Challenge

Full challenge composer:

- statement;
- side labels;
- context editor;
- stake/token;
- rounds;
- rules template;
- judge board picker;
- preview;
- create and generate invite link.

### Wallet / Balance

User balance page or panel:

- available;
- locked;
- spent;
- recent deposits;
- active locks;
- withdrawals;
- withdraw button.

## Visual Design

Design direction:

- dark but not generic navy/purple;
- serious financial surface;
- high contrast text;
- thin grid lines;
- crisp typography;
- no huge marketing hero;
- no bubbly cards;
- no decorative gradient orbs;
- all important pages should feel usable immediately.

Suggested palette:

- background: near black `#090a0c`
- panels: `#111418`
- elevated: `#171b20`
- border: `#2a3038`
- text: `#f4f7fb`
- muted: `#89939f`
- affirmative accent: `#15c47e`
- negative accent: `#ff5c5c`
- gold verdict accent: `#e7b84b`
- cyan network accent: `#2cc7ff`

Animations:

- animated debate timeline where new messages slide into a vertical transcript;
- subtle glowing escrow lock when funds move from available to locked;
- judge-board animation during judging:
  - 3/5/7 judge nodes orbit or pulse around a central verdict core;
  - each judge lights up when verdict arrives;
  - final winner side gets a decisive sweep animation;
- payout animation:
  - escrow pool splits into fee + winner payout;
  - winner side receives flowing token particles;
  - show `Queued`, `HTLC Finalized`, or `Failed` state.

Use CSS/Canvas/SVG as needed. If the frontend is static for MVP, keep animations lightweight and deterministic.

## Judge Board UX

Default boards:

1. **Classic 3**
   - Logic Judge
   - Evidence Judge
   - Rebuttal Judge

2. **Technical 5**
   - Systems Architect
   - Security Reviewer
   - Product Pragmatist
   - Cost Analyst
   - Final Arbiter

3. **Scientific 7**
   - Methodology
   - Evidence
   - Falsifiability
   - Counterargument
   - Clarity
   - Rule Compliance
   - Chair

Each judge config:

```json
{
  "id": "logic",
  "label": "Logic Judge",
  "provider": "placeholder",
  "model": "placeholder-v1",
  "weight": 1,
  "persona": "Evaluate internal consistency, causal claims, and direct rebuttals."
}
```

## Rules Templates

Implement at least:

- `General Debate`
- `Technical Comparison`
- `Product Decision`
- `Policy Debate`
- `Scientific Claim`

Each template defines criteria:

- logic;
- evidence;
- directness;
- rebuttal quality;
- clarity;
- rule compliance.

## Integrity And Safety

Required:

- immutable transcript after submission;
- hash each message body;
- hash final judge input packet;
- store judge outputs;
- store model/provider names;
- never let user-provided context override system instructions;
- include prompt-injection warning in judge system prompt;
- reject empty or oversized challenge content;
- rate-limit placeholder if no real auth yet;
- make paid challenge terms explicit before locking funds.

MVP disclaimer:

- This is not a legal court.
- AI verdicts are protocol/game outcomes.
- Paid challenges are voluntary escrow games/challenges unless a later legal wrapper exists.

## Implementation Priorities

### Phase 1: Static + DB + Placeholder AI

Goal: usable local MVP without real OpenRouter.

- Create `debates/` service.
- Implement SQLite store.
- Implement sessions.
- Implement balances and ledger helpers.
- Implement challenge lifecycle.
- Implement placeholder judge provider.
- Implement public UI.
- Implement create/accept/message/judge flows.
- Add deterministic demo seed route for dev only.

### Phase 2: XLN Deposits/Withdrawals

- Wire daemon client.
- Credit deposits from `HtlcReceived`.
- Implement withdrawal through `findRoutes` + `queuePayment`.
- Finalize/restore based on frame receipts.
- Add deposit instructions and QR.

### Phase 3: XLN Signed Login

- Add `Sign in with XLN`.
- Bind users to `entityId`/`signerId`.
- Keep cookie sessions but require signature for paid actions.

### Phase 4: Real AI Providers

- Add OpenRouter provider.
- Add model price estimates.
- Charge inference cost from balance.
- Store provider request/response metadata.

### Phase 5: Production Hardening

- Abuse controls.
- Private/unlisted access tokens.
- Judge retry policy.
- Appeal/rejudge mode.
- Better transcript hashing / export.
- Public API for challenge status.

## Acceptance Criteria

The local MVP is good enough when:

- user can open Debates app;
- user has a visible balance panel;
- user can create a free debate;
- user can create a paid debate if balance exists;
- user can attach context;
- user can choose judge board;
- user receives an invite link;
- second user/session can accept;
- both sides can submit all rounds;
- judge board animation runs;
- placeholder judges produce structured verdict;
- final verdict page is public;
- winner balance is credited;
- withdrawal UI exists, even if daemon is not configured;
- all money moves are ledgered;
- no route handler mutates balances outside store helpers.

## Build Style

Be pragmatic. Reuse custody patterns. Do not invent a framework unless needed.

If implementing as a Bun static service:

- keep TypeScript server clean;
- keep frontend in plain HTML/CSS/JS for first pass;
- make UI look premium anyway;
- avoid overbuilding auth before XLN signer APIs are clear.

If moving into the Svelte frontend later:

- preserve the same API and DB model;
- port UI components after the service behavior is proven.

## One-Sentence Product Definition

**XLN Debates is a public AI-judged challenge arena where users lock funds through XLN, argue under explicit rules, receive a transparent multi-model verdict, and withdraw winnings through the XLN payment network.**
