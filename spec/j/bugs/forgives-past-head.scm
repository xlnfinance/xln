;; Planted bug: the settlement deletes every listed claim it owes to the counterparty, wherever it is in the queue.
(define (forgive-walk queue ids)
  (dict :ok? #t
        :removed (filter (lambda (id) (find (lambda (d) (and (= (:id d) id) (equal? (:creditor d) :cp))) queue)) ids)))
