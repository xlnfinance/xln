;; A bound for the J page: R2C-DEBT-FIRST (coordinator, 09-30 15:23). The reserve is 4 and two debts of 1 are owed; a
;; call clears ONE claim (`enforce-cap` 1 stands for the contract's 32). The spendable reserve is 4 - 2 = 2, so the payment
;; r1 is covered. On chain the payment first enforces the whole queue, in two internal calls, and only then uses the
;; reserve: afterwards the queue is empty. No abort. Loaded after j/batch.scm.
(define ops (vector "r1"))
(define max-aborts 0)
(define enforce-cap 1)
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "r1")) (assoc-in (list :reserve) 4) (assoc-in (list :seed) 4)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1) (dict :id 2 :amount 1))) (assoc-in (list :debt0) 2))
        :next next :invariants invariants :at-rest (list) :goal finished?))
