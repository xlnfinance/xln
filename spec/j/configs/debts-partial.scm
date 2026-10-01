;; A bound for the J page: a part-paid claim (coordinator, 09-30 15:23, pinned against contracts/ at f996ff5). The entity owes
;; 2 and then 1; a deposit of 1 lands and the credit can pay only part of the oldest claim: it stays at the head of the queue,
;; reduced in place to 1, and the cursor does not advance. The goal: the deposit landed and nothing is in flight. Loaded after
;; j/batch.scm.
(define ops (vector "x1"))
(define max-aborts 0)
(define (deposit-landed? w)
  (and (member "x1" (:applied w)) (member "x1" (:done w)) (null? (:unsent w)) (equal? (:phase w) :idle)))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "x1")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0)
                       (assoc-in (list :debts) (list (dict :id 1 :amount 2) (dict :id 2 :amount 1))) (assoc-in (list :debt0) 3))
        :next next :invariants invariants :at-rest (list) :goal deposit-landed?))
