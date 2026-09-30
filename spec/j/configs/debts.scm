;; A bound for the J page with debts (coordinator, 09-30 13:50): the entity owes two debts of 1 and the chain clears at most
;; ONE debt per call (`enforce-cap` 1 stands for the contract's 32). A deposit of 2 lands: the credit pays the oldest debt
;; and one debt stays owed with a reserve of 1 behind it. That reserve is not spendable: the spendable reserve nets ALL
;; outstanding debt, the debt beyond the cap included, so the payment r1 waits until the second call has paid it and
;; nothing is left. The goal: the deposit is applied and both debts are paid. Loaded after j/batch.scm.
(define ops (vector "x1" "r1"))
(define max-aborts 0)
(define leg-amount 2)
(define enforce-cap 1)
(define (debts-settled? w)
  (and (member "x1" (:applied w)) (member "x1" (:done w)) (null? (:debts w)) (null? (:unsent w)) (equal? (:phase w) :idle)))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "x1" "r1")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 1) (dict :id 2 :amount 1))) (assoc-in (list :debt0) 2))
        :next next :invariants invariants :at-rest (list) :goal debts-settled?))
