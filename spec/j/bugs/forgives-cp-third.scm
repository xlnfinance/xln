;; Planted bug: on the counterparty's queue the creditor is not checked (the entity's queue is): its head is deleted whoever it is owed to.
(define (forgivable-cp? w) (pair? (:cp-debts w)))
(define (forgiven-claims queue creditor)
  (cond ((equal? creditor :entity) (if (pair? queue) (list (car queue)) (list)))
        ((forgivable? queue creditor) (list (car queue)))
        (else (list))))
