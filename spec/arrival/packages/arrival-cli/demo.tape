# demo.tape — arrival awesome-REPL wave 1 clip script.
# VHS tape format: https://github.com/charmbracelet/vhs (renders with `vhs demo.tape`).
#
# STATUS: NOT rendered in CI yet — no `vhs` binary is wired into this repo's pipeline.
# Wave 1's ship bar (per the brief) is a CORRECT, ready-to-render script, not a
# committed GIF. Render locally once `vhs` is installed (README:
# https://github.com/charmbracelet/vhs#installation — a single static binary, or
# `brew install vhs` / `go install github.com/charmbracelet/vhs@latest`):
#
#   cd foundations/arrival/arrival-cli
#   pnpm build          # dist/cli.js must exist — this tape invokes it directly,
#                        # not a globally-linked `arrival` bin
#   vhs demo.tape        # writes demo.gif next to this file
#
# THE SCRIPT (arrival-repl-viral-research.md §1.1 "first three seconds decide", §2):
# the wordmark splash gets ONE beat, not a scene — greeting flashes, then the
# paste-and-cascade starts by second ~2. Beats:
#
#   0.0s   greeting: default shibboleth quote (not the wordmark) + the fetch-style
#          identity line — held just long enough to read. Tape the wordmark with
#          ARRIVAL_BANNER=wordmark if that's the shot.
#   ~2s    ONE Enter submitting THREE top-level forms on one line — a real multi-form
#          topology in a single call (three separate Enters would fire three separate
#          single-form turns, not one cascading topology): topology paints all three
#          blocks pending, then each settles to `done` in sequence as its statement
#          event lands — the tint-cascade clip (§5, "the clip")
#   ~6s    a deliberate unbound-symbol call, plus a second form after it: the first
#          block tints error (door text, no stack trace), the second flips to the
#          DISTINCT skipped tint ("queued but never reached" vs "still queued")
#   ~10s   `,lens` — the whole scrollback re-renders scheme→sugarcoat: the classic
#          `(filter even? squares)` becomes sugarcoat's `squares.filter{even?}` (curly-
#          infix render), the "same program, two surfaces" before/after pair (§2 pt. 5)
#   ~12s   `,lens` again — flips back, closing the pair
#   ~14s   Ctrl-D — session ends
#
# NOTE ON INPUT SYNTAX: typed input is CLASSIC scheme only (the core reader has no
# curly-infix mode — verified against HEAD, see lens.ts's header comment for the
# empirical correction to the design doc's §8 claim). `,lens` flips how the ECHOED
# source and RESULT values are rendered, not what's accepted at the prompt — the tape
# types plain `(filter even? squares)`, and `,lens` is what makes it SHOW as sugarcoat.

Output demo.gif

Set Shell "bash"
Set FontSize 20
Set Width 1200
Set Height 720
Set Padding 20
Set TypingSpeed 40ms
Set Theme "Dracula"

Type "node dist/cli.js repl"
Enter
Sleep 1800ms

# Three forms, one Enter — one topology, three blocks cascading pending → done.
Type `(define squares (map (lambda (n) (* n n)) (iota 6))) (filter even? squares) (filter odd? squares)`
Enter
Sleep 2200ms

# A deliberate crash, plus a form after it that never runs — error + skipped tints.
Type `(frobnicate squares) (+ 1 1)`
Enter
Sleep 2000ms

# The before/after pair: same scrollback, sugarcoat surface.
Type ",lens"
Enter
Sleep 2200ms

# Flip back to classic — closes the pair.
Type ",lens"
Enter
Sleep 1500ms

Ctrl+D
Sleep 500ms
