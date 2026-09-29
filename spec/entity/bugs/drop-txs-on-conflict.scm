;; Planted bug: R-E3 done half way. The proposal is dropped and the certified frame installed,
;; but the txs of the dropped proposal are forgotten instead of staying in the mempool.
(define (on-conflict w side f)
  (assoc-in (assoc-in w (list side) (install (side w) f)) (list side :mempool) (list)))
