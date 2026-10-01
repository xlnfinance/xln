;; Planted bug: no H1 wait. An HTLC whose secret is not public yet is settled as unpaid
;; even though its deadline has not passed.
(define (clause-outcome w p)
  (let ((c (p-clause p)))
    (cond ((not c) :none)
          ((secret-public-by? w (:deadline c)) :paid)
          (else :unpaid))))
