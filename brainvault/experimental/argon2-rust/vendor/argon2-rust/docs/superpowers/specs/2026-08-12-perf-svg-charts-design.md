# Performance tables → animated SVG charts

Date: 2026-08-12  
Status: approved  
Affects: `README.md`, new `assets/perf/*.svg`

## Goal

Replace dense performance *number* tables in the README with horizontal animated
SVG bar charts. Keep host-spec, feature-flag, and instruction-count tables as
Markdown. Put exact numbers in a collapsed `<details>` under each chart.

## Scope (charts)

| Chart | Source table |
|---|---|
| `m5-max-vs-c.svg` | Apple M5 Max vs C `ref.c` (scalar + neon + C) |
| `epyc-vs-c.svg` | EPYC Genoa vs C AVX-512 |
| `epyc-backends.svg` | EPYC same-ISA whole-hash ranges |
| `spr-vs-c.svg` | Sapphire Rapids vs C native |
| `spr-backends.svg` | SPR same-ISA ranges (whole-hash) |
| `link-mode.svg` | dlopen bias (normalized to static) |
| `openssl.svg` | vs OpenSSL 3.5 |
| `crates-x86.svg` | vs RustCrypto / rust-argon2 on SPR |
| `crates-aarch64.svg` | vs RustCrypto / rust-argon2 on Apple Silicon |

Out of scope: host inventory table, feature flags, `fill_block` instruction
table, ASCII dispatch diagram.

## Visual system

- Canvas: GitHub-dark friendly (`#0d1117` fill, `#30363d` stroke)
- Series colors: argon2-rust accent green; competitors muted purple / orange / gray
- Horizontal bars: bar length ∝ wall-clock ms (or range midpoint for range charts)
- Labels: config on the left; ms value at bar end; speedup badge where relevant
- Animation: CSS `@keyframes` bar grow from 0 width + staggered opacity (≤1.2s)
- No JS; SMIL optional; must work as `<img src="...svg">` on GitHub

## Integration

```markdown
![title](assets/perf/foo.svg)

<details>
<summary>Raw numbers</summary>

| ... | table preserved |
</details>
```

Relative paths for GitHub. Charts are hand-maintained SVG assets under
`assets/perf/` (no generator language in-tree). Re-measure benches, then edit
the matching SVG (and the `<details>` table) with the new numbers.

## Non-goals

- Interactive hover charts
- Live CodSpeed embeds as replacements for these static claims
- Changing any measured numbers
- An in-repo chart generator (Python or otherwise)
