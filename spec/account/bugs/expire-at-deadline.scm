;; Planted bug: the receiver expires a lock as soon as its own view REACHES deadline + reserve, not when it is past it. The other party's view may
;; lag by LAG, so it can still be AT the deadline, where the lock is live: the payee resolves a lock the payer just took back (R-HTLC-CLOCK b).
;; Quint's mutant of the same name is the same change.
(define (lock-expired? w stamp) (>= (own-now w :right) (+ lock-deadline clock-reserve)))
