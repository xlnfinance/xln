;; A bound for the J page: the settlement lists token 2, which carries no debts, while the head claim of token 1 is owed to the counterparty: nothing is forgiven there and the settlement lands (the listed token ids are read, not ignored). Loaded after j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 2))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :cp))) (assoc-in (list :debt0) 1)
                       (assoc-in (list :cp-debts) (list)) (assoc-in (list :cp-debt0) 0))
        :next next :invariants invariants :at-rest (list) :goal finished?))
