;; Planted bug: the receiver decides that the lock expired from the timestamp in the frame. A payer
;; stamps the frame in the future and expires the lock before the payee's own deadline (R-CLOCK,
;; part 2).
(define (lock-expired? w stamp) (>= stamp (+ lock-deadline clock-reserve)))
