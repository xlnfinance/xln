;; Planted bug: a frame whose stamp is older than the receiver's clock by more than a tolerance is
;; refused (og-style freshness check). The signed frame stays pending, the proposer resends the same
;; one and it is refused again: the Account has no exit (R-CLOCK, part 1).
(define (refused-for-stamp? w stamp) (< (+ stamp max-age) (own-now w :right)))
