;; Planted bug: several deposit legs share one batch. A token paused after the simulation reverts the whole batch, and
;; with it the legs of other tokens that would have landed (J6).
(define (pick-ops draft)
  (let ((fin (find finalize? draft)) (disputes (filter dispute-op? draft)) (legs (filter leg? draft))
        (cosigned (find cosigned? draft)))
    (cond (fin (list fin))
          ((pair? disputes) disputes)
          ((pair? legs) legs)
          (cosigned (filter (lambda (op) (equal? (account-of op) (account-of cosigned))) draft))
          (else draft))))
