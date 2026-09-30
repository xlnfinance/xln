;; Planted bug: a finalize is stale only when it was already applied; a finalize prepared for the initial proof still
;; goes through after a counter landed (before R-J2 was extended, coordinator 23:42).
(define (stale-op? w op)
  (and (dispute-op? op)
       (or (member op (:applied w))
           (and (counter? op) (member "fin-a" (:applied w))))))
