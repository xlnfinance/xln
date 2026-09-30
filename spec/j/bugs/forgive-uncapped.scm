;; Planted bug: no cap on the ids a settlement lists, however many.
(define (forgive-plan w) (forgive-walk (:debts w) (forgive-ids)))
