;; Planted bug: installing a certified frame does not remove its txs from the mempool, so they are
;; proposed again and committed twice.
(define (install r f)
  (-> r
      (update-in (list :committed) (lambda (cs) (append cs (list f))))
      (assoc-in (list :phase) :open)
      (assoc-in (list :proposal) #f)
      (assoc-in (list :signed) #f)))
