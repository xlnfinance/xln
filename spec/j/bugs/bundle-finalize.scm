;; Planted bug: a finalize is bundled with the other dispute ops in the draft (the split between
;; dispute and payment ops is kept). While Account A's HTLC deadline is open the finalize reverts, and
;; the whole batch with it: the counter that rode along is held up (coordinator N2).
(define (pick-ops draft)
  (let ((disputes (filter dispute-op? draft)))
    (if (pair? disputes) disputes draft)))
