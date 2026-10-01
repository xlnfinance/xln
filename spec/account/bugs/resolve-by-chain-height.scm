;; Planted bug: the payer judges a resolve by the chain height itself, not by its own view. A payer whose view lags still sees the lock live
;; (its view <= deadline) and refuses a resolve that was on time (R-HTLC-CLOCK a).
(define (resolve-late? w stamp) (> (:jh w) lock-deadline))
