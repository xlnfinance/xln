;; Planted bug: what the contracts do today. A dispute op that is stale or already applied makes the
;; whole batch revert, so an unrelated op in the same batch (a deposit, a secret reveal) is held up
;; by it (coordinator J2).
(define (op-ok? w op reserve)
  (cond ((stale-op? w op) #f)
        ((finalize? op) (h1-wait-over? w))
        ((counter? op) #t)
        (else (>= reserve 1))))
