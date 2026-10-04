;; The swap page without the R-SWAP-CLAUSE-WITH-FILL world property: the dispute must kill `swap-fill-leaves-clause`
;; alone (the stale clause is seen where it hurts, in the settlement, not only in the body).
(define invariants
  (filter (lambda (pr) (not (string-prefix? "R-SWAP-CLAUSE-WITH-FILL R-BOOK-CLAUSE-LOCKSTEP: the signed clause" (:name pr)))) invariants))
(define account-swap (dict :init init :next next :invariants invariants :steps steps :at-rest (list) :goal settled?))
