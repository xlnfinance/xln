;; The debts bound with a deposit of 3 (coordinator, 09-30 13:50): after the credit pays the oldest debt the reserve is 2
;; and one debt of 1 is still owed, so the spendable reserve is 1 and the payment r1 is covered: it lands whether or not
;; the second enforcement call ran first. Loaded after j/batch.scm.
(define ops (vector "x1" "r1"))
(define max-aborts 0)
(define leg-amount 3)
(define enforce-cap 1)
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "x1" "r1")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1) (dict :id 2 :amount 1))) (assoc-in (list :debt0) 2))
        :next next :invariants invariants :at-rest (list) :goal finished?))
