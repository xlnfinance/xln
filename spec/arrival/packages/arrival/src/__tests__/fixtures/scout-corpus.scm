; scout-corpus.scm — the shared conformance corpus for the constraint-kernel oracle (Track O / O0).
;
; Each non-comment, non-blank line is ONE corpus entry: a partial or whole scout program SOURCE.
; The conformance suite scans EVERY PREFIX of every entry and asserts that arrival's Layer-S
; structural reader agrees with sift's reference reader (sift/src/sampler/prefix-oracle.ts) on every
; shared structural field — and that the resumable session agrees with from-scratch analyze on every
; prefix. Lines are grouped (valid / truncated / misnested / mid-token) but the suite treats them
; uniformly; the grouping is for the human reader.
;
; NOTE: this file is read as raw text by the suite (NOT evaluated). The leading `;` comments here
; are themselves part of the corpus's comment-handling coverage, but the suite splits on newlines
; and skips blank lines and lines whose first non-space char is `;`.

; --- valid, complete scout programs (closeable at EOF) ---
(net)
(net flows)
(define x 1)
(filter signable flows)
(correlate (pid 3644) (file "coreupdater.ex"))
(@ ForeignAddr conn)
(lambda (x) (+ x 1))
(quote (a b c))
'(a b c)
(if signable (commit) (defer))
(and (rwx? p) (masquerade? p))
(let ((x 1) (y 2)) (+ x y))
(begin (scan disk) (report))

; --- truncated prefixes (open forms / mid-string / mid-comment — the oracle's normal case) ---
(net
(filter signable
(correlate (pid 3644)
(@ ForeignAddr
(lambda (x)
(if signable
(define x "unterminated
(scan ; trailing line comment
(begin #| open block comment
(let ((x 1) (y

; --- misnested (a close before its open — feasible must be false) ---
)
(a))
(foo) )
((bar)

; --- mid-token symbol prefixes (the char-vs-token gap case) ---
(net
(netw
(corre
(@ Foreign
(sign
