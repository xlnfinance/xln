;; Planted bug: rolled-back txs are proposed again without checking them against the new head.
(define (split-valid before txs) (dict :valid txs :refused (list)))
