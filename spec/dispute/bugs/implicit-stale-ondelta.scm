;; Planted bug (review B of PR 76, finding 2): a dispute from the implicit proof settles at the ondelta of the epoch
;; advance and ignores a deposit made inside the epoch. The chain reads its ondelta now (a Left deposit raised it).
(define (final-delta w p outcome)
  (- (+ (if (p-implicit? p) (:adv-ondelta w) (:ondelta w)) (p-off p))
     (if (equal? outcome :paid) (clause-amount (p-clause p)) 0)))
