;; Planted bug: the guard checks RCPAN at the current Δ only, not in the worst case over open clauses.
(define (rcpan-ok? w)
  (and (>= (total-delta w) (- (:credit-left w)))
       (<= (total-delta w) (+ (:collateral w) (:credit-right w)))))
