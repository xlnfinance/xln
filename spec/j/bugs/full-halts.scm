;; Planted bug: what xln.ts does today (`batchRoom` -> `j_batch` -> `entity_invariant`, a halt).
;; A full draft halts the Entity instead of refusing the op with notice.
(define (full-draft w op) (assoc-in w (list :halted) #t))
