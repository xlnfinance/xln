;; Planted bug: right puts its rolled-back txs behind its mempool instead of ahead of it.
(define (roll-back r)
  (-> r (update-in (list :mempool) (lambda (m) (append m (:txs (:pending r)))))
        (assoc-in (list :pending) #f)))
