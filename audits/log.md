# Audit Log

Purpose: track external AI audits with a terse usefulness score so we can ask the strongest reviewer more often.

## Running Summary

- Reports logged: 6
- Average score: 858/1000
- Current best reviewer: Codex - strongest launch-blocker audit so far; tied findings directly to XLN nonce, finality, and Hanko enforceability.

## 2026-06-20 - Runtime Security / Settlement / TRON / Hanko

| Reviewer | Score | One-line verdict |
| --- | ---: | --- |
| Codex | 930/1000 | Excellent signal: all 3 P1s reproduced against real XLN paths, with no generic crypto noise. |
| Claude mainnet-readiness | 805/1000 | Strong TRON finality and determinism pass, but under-called settlement nonce risk and treated a different Hanko issue as the whole Hanko class. |

Best of round: Codex; this is the audit style to repeat for capped-testnet launch blockers.

## 2026-06-20 - MM Bootstrap Stall / Account Resend Liveness

| Reviewer | Score | One-line verdict |
| --- | ---: | --- |
| Claude MM liveness | 910/1000 | Strong root-cause split: traced wrong crontab resend signer, explained retarget warning as resend fallout, and identified the decisive hub-log fork between frame rejection and missing duplicate re-ACK. |

Best of round: Claude MM liveness; stronger than the signer-only hypothesis because it gives a concrete falsifiable next diagnostic and an account-consensus liveness fix path.

## 2026-06-19 - Frontend Time-Machine / Runtime Env Contract

| Reviewer | Score | One-line verdict |
| --- | ---: | --- |
| Grok | 760/1000 | Broad and useful grep coverage, but over-called several intended fail-loud/disabled action guards as bugs. |
| Claude | 900/1000 | Best overall: found the real `isLive=false/timeIndex=-1` desync and separated confirmed bugs from speculative split-store risks cleanly. |
| Flash | 840/1000 | Strong incremental find on `EnvSnapshot` being accepted as live env, plus Graph3D periodic-payment risk; a few findings depended on that root bug. |

Best of round: Claude overall; Flash had the most valuable new root-cause finding after Claude's pass.
