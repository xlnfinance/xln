;; The swap page without the R-SWAP-ALLOWANCES world property: a clause with no allowance must still be seen alone, by the
;; dispute (`swap-clause-no-allowance`: the finalize would revert, so no dispute may start from that body).
(define invariants
  (filter (lambda (pr) (not (string-prefix? "R-SWAP-ALLOWANCES: every clause allows" (:name pr)))) invariants))
(define account-swap (dict :init init :next next :invariants invariants :steps steps :at-rest (list) :goal settled?))
