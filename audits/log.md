# Audit Log

Purpose: track external AI audits with a terse usefulness score so we can ask the strongest reviewer more often.

## Running Summary

- Reports logged: 4
- Average score: 857/1000
- Current best reviewer: Codex - strongest launch-blocker audit so far; tied findings directly to XLN nonce, finality, and Hanko enforceability.

## 2026-06-20 - Runtime Security / Settlement / TRON / Hanko

| Reviewer | Score | One-line verdict |
| --- | ---: | --- |
| Codex | 930/1000 | Excellent signal: all 3 P1s reproduced against real XLN paths, with no generic crypto noise. |

Best of round: Codex; this is the audit style to repeat for capped-testnet launch blockers.

## 2026-06-19 - Frontend Time-Machine / Runtime Env Contract

| Reviewer | Score | One-line verdict |
| --- | ---: | --- |
| Grok | 760/1000 | Broad and useful grep coverage, but over-called several intended fail-loud/disabled action guards as bugs. |
| Claude | 900/1000 | Best overall: found the real `isLive=false/timeIndex=-1` desync and separated confirmed bugs from speculative split-store risks cleanly. |
| Flash | 840/1000 | Strong incremental find on `EnvSnapshot` being accepted as live env, plus Graph3D periodic-payment risk; a few findings depended on that root bug. |

Best of round: Claude overall; Flash had the most valuable new root-cause finding after Claude's pass.
