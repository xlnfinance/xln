;; A bound for the J page: the forgiveness cap (coordinator, 09-30 16:12). `forgive-cap` 1 stands for the contract's 32 and the
;; settlement lists two claims, both owed to the counterparty: it lists more than the cap, so it reverts whole. Loaded after
;; j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 1 2))
(define forgive-cap 1)
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :cp) (dict :id 2 :amount 1 :creditor :cp)))
                       (assoc-in (list :debt0) 2))
        :next next :invariants invariants :at-rest (list) :goal finished?))
