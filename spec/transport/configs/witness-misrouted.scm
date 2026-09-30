;; Witness: the sender holds a committed frame and a stale directory entry, so its next send is refused ("misrouted"). Adds an
;; invariant that says it never happens; the check must FAIL on it. It shows the refusal path is reachable.
(define transport
  (assoc-in transport (list :invariants)
            (append invariants
                    (list (property "witness T-misrouted: a message is refused as misrouted" (w)
                            (not (and (equal? (:dir w) "old") (pair? (:wal w)) (> (length (:wal w)) (:acked w)))))))))
