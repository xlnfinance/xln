;; A bound for the J page: a third party's claim at the head (coordinator, 09-30 16:12). The settlement lists claims 1 and 2;
;; claim 1 belongs to the settling counterparty, but after it is deleted the head is claim 2, owed to a third party. The whole
;; settlement reverts: nothing of it applies, the batch is BatchFailed and the settlement goes back to its Account. Loaded
;; after j/batch.scm.
(define ops (vector "stl-a"))
(define max-aborts 0)
(define forgive (vector 1 2))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "stl-a")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1 :creditor :cp) (dict :id 2 :amount 1 :creditor :third)))
                       (assoc-in (list :debt0) 2))
        :next next :invariants invariants :at-rest (list) :goal finished?))
