;; A bound for the J page: a repeated token. The settlement lists token 1 twice: it reverts whole (E2), though the head claim is owed to the counterparty. Loaded after j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 1 1))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :cp) (dict :id 2 :amount 1 :creditor :cp))) (assoc-in (list :debt0) 2)
                       (assoc-in (list :cp-debts) (list)) (assoc-in (list :cp-debt0) 0))
        :next next :invariants invariants :at-rest (list) :goal finished?))
