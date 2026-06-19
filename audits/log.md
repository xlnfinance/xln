# Audit Log

Purpose: track external AI audits with a terse usefulness score so we can ask the strongest reviewer more often.

## Running Summary

- Reports logged: 3
- Average score: 833/1000
- Current best reviewer: Claude - best precision and lowest false-positive rate on the frontend time-machine contract.

## 2026-06-19 - Frontend Time-Machine / Runtime Env Contract

| Reviewer | Score | One-line verdict |
| --- | ---: | --- |
| Grok | 760/1000 | Broad and useful grep coverage, but over-called several intended fail-loud/disabled action guards as bugs. |
| Claude | 900/1000 | Best overall: found the real `isLive=false/timeIndex=-1` desync and separated confirmed bugs from speculative split-store risks cleanly. |
| Flash | 840/1000 | Strong incremental find on `EnvSnapshot` being accepted as live env, plus Graph3D periodic-payment risk; a few findings depended on that root bug. |

Best of round: Claude overall; Flash had the most valuable new root-cause finding after Claude's pass.
