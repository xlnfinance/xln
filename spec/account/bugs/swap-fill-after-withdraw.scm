;; Planted bug (R-SWAP-WITHDRAW): a fill looks at the deadline and forgets the status: an offer the maker withdrew
;; can still be filled (and comes back to life).
(define (fillable? w o) (<= (:now w) (:deadline o)))
