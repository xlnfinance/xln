;; Planted bug: a co-signed op (a settlement) is bundled with the other soft ops in the draft, whatever their Account
;; (R-COSIGN). A counterparty's state change fails the settlement's signature and the whole batch with it, so an
;; unrelated reserve deposit is held up by another Account's settlement.
(define (pick-ops draft)
  (let ((fin (find finalize? draft)) (disputes (filter dispute-op? draft)) (legs (filter leg? draft)))
    (cond (fin (list fin))
          ((pair? disputes) disputes)
          ((pair? legs) legs)
          (else draft))))
