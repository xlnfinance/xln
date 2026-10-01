;; A bound for the J page: a listed claim that is not the head is not deleted (coordinator, 09-30 16:12, "only the head claim").
;; Both claims are owed to the counterparty; the settlement lists claim 2, which is behind claim 1. Nothing is deleted and the
;; settlement lands. Loaded after j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 2))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :cp) (dict :id 2 :amount 1 :creditor :cp)))
                       (assoc-in (list :debt0) 2))
        :next next :invariants invariants :at-rest (list) :goal finished?))
