;; Planted bug: the final Δ forgets the chain's ondelta; only the off-chain part counts.
(define (final-delta w p outcome)
  (- (p-off p) (if (equal? outcome :paid) (clause-amount (p-clause p)) 0)))
