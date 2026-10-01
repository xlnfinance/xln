;; Planted bug: the settlement deletes every claim owed to the counterparty, wherever it is in the queue.
(define (forgiven-claims queue creditor) (filter (lambda (d) (equal? (:creditor d) creditor)) queue))
