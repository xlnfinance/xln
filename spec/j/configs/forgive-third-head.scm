;; A bound for the J page: a third party at the head. The entity's head claim is owed to a third party and there is nothing to forgive in the other direction: the whole settlement reverts, nothing of it applies, the batch is BatchFailed and the settlement goes back to its Account. Loaded after j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 1))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :third) (dict :id 2 :amount 1 :creditor :cp))) (assoc-in (list :debt0) 2)
                       (assoc-in (list :cp-debts) (list)) (assoc-in (list :cp-debt0) 0))
        :next next :invariants invariants :at-rest (list) :goal finished?))
