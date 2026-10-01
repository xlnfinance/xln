;; A bound for the J page: both sides' head claims are owed to third parties, so nothing is forgiven in either direction and the settlement reverts whole; the counterparty's queue checks its creditor too. Loaded after j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 1))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :third))) (assoc-in (list :debt0) 1)
                       (assoc-in (list :cp-debts) (list (dict :id 1 :amount 1 :creditor :third))) (assoc-in (list :cp-debt0) 1))
        :next next :invariants invariants :at-rest (list) :goal finished?))
