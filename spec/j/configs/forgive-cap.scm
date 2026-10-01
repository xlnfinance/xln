;; A bound for the J page: the listing cap. `forgive-cap` 1 stands for the contract's 32 and the settlement lists tokens 1 and 2: more than the cap, so it reverts whole (E10). Loaded after j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 1 2))
(define forgive-cap 1)
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :cp))) (assoc-in (list :debt0) 1)
                       (assoc-in (list :cp-debts) (list)) (assoc-in (list :cp-debt0) 0))
        :next next :invariants invariants :at-rest (list) :goal finished?))
