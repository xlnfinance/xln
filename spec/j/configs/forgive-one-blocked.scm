;; A bound for the J page: one direction blocked. The entity's head claim is owed to a third party, the counterparty's head claim to the entity: the counterparty's is forgiven and the settlement lands (the contract reverts only when nothing was forgiven). Loaded after j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 1))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :third))) (assoc-in (list :debt0) 1)
                       (assoc-in (list :cp-debts) (list (dict :id 1 :amount 1 :creditor :entity))) (assoc-in (list :cp-debt0) 1))
        :next next :invariants invariants :at-rest (list) :goal finished?))
