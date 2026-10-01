;; Planted bug: the creditor is not checked: a settlement deletes a head claim owed to a third party.
(define (forgivable? queue creditor) (pair? queue))
