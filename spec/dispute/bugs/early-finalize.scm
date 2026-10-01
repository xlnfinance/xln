;; Planted bug: the initial proof can be finalized before T by either side, so a stale start
;; is settled before the responder has had its window.
(define finalize-initial
  (rule "finalize initial" (w side)
    (when (and (:dispute w) (not (:counter (:dispute w)))
               (not (equal? (clause-outcome w (:initial (:dispute w))) :wait))))
    (then (let ((d (:dispute w)))
            (finalized w d (:initial d) (clause-outcome w (:initial d)) "5c")))))
