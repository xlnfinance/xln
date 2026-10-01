;; Routing without the R3 property: the loss property alone must kill `dispute-omits-secret` (the
;; second-round review's B4: R3 must not be checked only by the property that repeats its guard).
(define invariants
  (filter (lambda (pr) (not (equal? (:name pr) "a dispute start publishes every secret H knows (R3)"))) invariants))
(define routing (dict :init init :next next :invariants invariants :at-rest (list)))
