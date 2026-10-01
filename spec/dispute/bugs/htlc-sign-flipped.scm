;; Planted bug: a paid HTLC moves Δ the wrong way (Left's payment is credited to Left).
(define (final-delta w p outcome)
  (+ (+ (:ondelta w) (p-off p)) (if (equal? outcome :paid) (clause-amount (p-clause p)) 0)))
