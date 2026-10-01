;; A bound for the J page: settlement debt forgiveness, the plain case. The entity owes two claims, 1 to the settling counterparty and 2 to a third party. The settlement lists token 1: the head claim, owed to the counterparty, is deleted and the settlement lands. Loaded after j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 1))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :cp) (dict :id 2 :amount 1 :creditor :third))) (assoc-in (list :debt0) 2)
                       (assoc-in (list :cp-debts) (list)) (assoc-in (list :cp-debt0) 0))
        :next next :invariants invariants :at-rest (list) :goal finished?))
