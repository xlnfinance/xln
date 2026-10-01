;; Planted bug: a Left deposit raises the collateral but not ondelta (Left's allocation).
(define (move-collateral w side amount)
  (-> w (update-in (list :collateral) (lambda (c) (+ c amount)))
        (update-in (list :reserve side) (lambda (r) (- r amount)))))
