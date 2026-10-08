# xln core technical manual

Russian source-backed manual: 28 pages, 40 vector figures. Code baseline:
`d6a0845fd96c885f3033c2752aad493ab7103661`, 2026-10-06.

- `content.json`: chapter text, primary diagrams, tables and source references.
- `details.json`: additional numerical, timing and failure-boundary diagrams.
- `build.py`: PDF renderer and Markdown export; requires Python and ReportLab.
- `fonts/`: static fonts and their OFL licenses. Distinct font names preserve
  regular/bold and semibold/extrabold faces during PDF embedding.
- `xln-core-technical-manual.md`: generated editable reading copy.

Run from the repository root:

```sh
python3 docs/ru/xln-core-manual/build.py
```

The PDF is written to `docs/ru/output/pdf/xln-core-technical-manual.pdf`. Fonts are
embedded; diagrams remain vectors. The renderer rejects page or diagram-box
overflow. `XLN_MANUAL_FONTS` may point to a separate directory with the same five
font files. The italic face currently uses macOS Georgia Italic.

Rendered QA images and extracted-text checks belong in `/tmp/xln-core-manual/`,
outside the documentation deliverable. Review all pages after an edit. Core
verification at this baseline is recorded on page 27; the manual does not claim
that the full repository check or release gates passed.
