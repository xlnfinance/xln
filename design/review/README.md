# Wallet design review loop

One iteration:

```bash
cd ui && bun run dev                      # serves the wallet on :5183 (leave running)
bun ui/tools/design-shots.ts              # 4 variants × 9 screens → design/screenshots/ui/
bun ui/tools/design-review.ts             # GLM-4.6V + Gemini Flash + Grok score them → design/review/<date>/summary.md
```

Then read `summary.md`, pick the fixes that move the lowest parameters, change
`ui/src`, and run the two commands again. Keep the previous `design/review/<date>/`
folders: the score table per date is the progress chart.

Options:

- `UI_SHOT_VARIANTS=desktop-dark,mobile-dark bun ui/tools/design-shots.ts` — subset of variants.
- `bun ui/tools/design-review.ts --models zai-coding-cn/glm-4.6v --variants desktop-dark --run 2026-09-04-b` — one model, one variant, named run.
- Reviewers are any pi model with image input (`pi --list-models openrouter | grep yes$`).

The rubric (`rubric.md`) fixes the ten parameters and the JSON shape; change it
only together with the reviewers' history, otherwise scores stop being comparable.
