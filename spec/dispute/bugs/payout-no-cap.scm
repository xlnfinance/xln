;; Planted bug: when Δ exceeds the collateral, Left is paid the whole Δ out of the collateral
;; instead of the collateral, with the excess owed by Right.
(define (payout w delta)
  (let ((c (:collateral w))
        (w0 (-> w (assoc-in (list :collateral) 0) (assoc-in (list :ondelta) 0))))
    (cond ((<= delta 0) (shortfall (add-reserve w0 :right c) :left (- delta)))
          ((< delta c)  (add-reserve (add-reserve w0 :left delta) :right (- c delta)))
          (else         (add-reserve w0 :left delta)))))
