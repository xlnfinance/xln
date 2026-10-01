;; Planted bug: a shortfall is taken from the debtor's reserve without the cap. The reserve goes
;; negative and no debt is booked (money is created on the creditor's side).
(define (shortfall w debtor amount)
  (-> w (add-reserve debtor (- amount)) (add-reserve (peer debtor) amount)))
