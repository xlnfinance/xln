;; Planted bug: installing a certified frame does not move the replica to the frame's view. The
;; replica that dropped its proposal (R-E3) stays in the old view, the others refuse its next
;; frame, and nobody sends its txs to the new leader.
(define (on-commit w side m)
  (let ((r (side w)) (f (:frame m)))
    (cond ((not (certified-here? r f)) w)
          ((and (:proposal r) (not (equal? (:proposal r) f))) (on-conflict w side f))
          (else (assoc-in w (list side) (install r f))))))
