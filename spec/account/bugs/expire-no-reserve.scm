;; Planted bug: an expiry waits for the deadline to pass on the receiver's own view and adds no reserve. The other party's view may still be at
;; the deadline (R-HTLC-CLOCK b, R-DRIFT).
(define (lock-expired? w stamp) (> (own-now w :right) lock-deadline))
