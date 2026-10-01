;; Planted bug (review B of PR 76, finding 2): the decision text said a reserve-to-collateral deposit advances the
;; epoch. It does not: only a dispute finalize, a co-signed withdrawal and a settlement do. Modelled as a deposit
;; that bumps the epoch, which would kill every signed frame of the epoch.
(define (deposit-rule funder beneficiary)
  (rule (str "deposit " funder "->" beneficiary) (w side)
    (when (and (equal? side funder) (deposit-open? w) (= (:deposits w) 0) (>= (get-in w (list :reserve funder)) 1)))
    (then (-> w (update-in (list :collateral) (lambda (c) (+ c 1)))
                (update-in (list :ondelta) (lambda (o) (ledger-deposit-ondelta o beneficiary 1)))
                (add-reserve funder -1)
                (update-in (list :epoch) (lambda (e) (+ e 1)))
                (update-in (list :deposits) (lambda (n) (+ n 1)))
                (assoc-in (list :deposit) (list funder beneficiary))))))
