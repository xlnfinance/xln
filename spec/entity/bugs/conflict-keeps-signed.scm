;; Planted bug: on a conflict the replica installs the certified frame but keeps its signature on
;; the old proposal, so it can never sign at that height again.
(define (on-conflict w side f)
  (assoc-in w (list side) (assoc-in (install (side w) f) (list :signed) (:proposal (side w)))))
