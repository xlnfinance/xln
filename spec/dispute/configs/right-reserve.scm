;; Right holds a reserve of 1 (the base gives it none): a Right-funded deposit during a dispute (H4) can happen, Right
;; can pay a shortfall from a reserve first, and the `min(amount, reserve)` split can be partial in both directions.
;; Loaded after dispute.scm; the page's init and its spec dict capture the reserve at definition, so both are rebuilt.
(define reserve-right0 1)
(define init (assoc-in init (list :reserve :right) 1))
(define dispute (dict :init init :next next :invariants invariants :steps steps :at-rest (list) :goal settled?))
