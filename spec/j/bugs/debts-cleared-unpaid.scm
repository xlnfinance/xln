;; Planted bug: enforcement clears the debts it reaches but never takes the payment from the reserve: the debts
;; vanish and the creditors are not paid.
(define (finish-enforce w cleared updated reserve)
  (assoc-in w (list :debts) (filter (lambda (d) (not (member (:id d) cleared))) (:debts w))))
