;; Planted bug: what the contracts do today. A dispute op that is stale or already applied makes the
;; whole batch revert, so an unrelated op in the same batch (a deposit, a secret reveal) is held up
;; by it (coordinator R-J2).
(define (op-ok? w op reserve)
  (cond ((stale-op? w op) #f)
        ((finalize? op) (> (:now w) a-deadline))
        ((counter? op) #t)
        (else (>= reserve 1))))
