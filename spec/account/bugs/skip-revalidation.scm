;; Planted bug: rolled-back txs are proposed again without checking them against the new head.
(define (proposal-valid? before tx) #t)
