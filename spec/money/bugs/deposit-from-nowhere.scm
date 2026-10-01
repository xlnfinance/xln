;; Planted bug: a deposit into collateral forgets to take the amount out of the reserve.
(define (move-collateral w side amount)
  (-> w (update-in (list :collateral) (lambda (c) (+ c amount)))
        (update-in (list :ondelta) (lambda (o) (if (equal? side :left) (+ o amount) o)))))
