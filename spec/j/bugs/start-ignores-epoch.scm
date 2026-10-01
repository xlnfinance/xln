;; Planted bug: a dispute start does not carry the account's ondeltaEpoch, so it applies after the epoch moved
;; (coordinator, 01:16) and opens a dispute on an epoch its proofs are void in.
(define (stale-op? w op)
  (and (dispute-op? op)
       (or (member op (:applied w))
           (and (counter? op) (member "fin-a" (:applied w)))
           (and (finalize? op) (member "cnt-a" (:applied w))))))
