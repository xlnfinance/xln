;; Planted bug: the first frame of the new epoch takes its proof nonce from the chain nonce instead of
;; clearing the baselines both sides hold. A baseline (offdelta 0) then outranks the newest committed
;; frame and a dispute can pay from it.
(define (post-nonce w) (+ 1 (:chain-nonce w)))
