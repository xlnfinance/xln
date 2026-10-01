;; Planted bug: what xln.ts does today (commit_conflict, pure/xln.ts:28705). A validator that
;; holds its own uncommitted proposal and receives a different certified frame at that height
;; refuses it and keeps the proposal: it is stranded at the old height forever.
(define (on-conflict w side f) w)
