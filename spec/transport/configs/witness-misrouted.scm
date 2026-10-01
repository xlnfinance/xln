;; Witness: a message is refused as "misrouted" in some run: the sender sends a committed frame to a stale address ("misrouted"). Loaded after transport/configs/recording-refuse.scm. It adds an
;; invariant that says this never happens; the check must FAIL on it (the trace is emit, persist, send 1). It shows the refusal branch RUNS,
;; so the properties around it are not vacuous.
(define transport
  (assoc-in transport (list :invariants)
            (append invariants
                    (list (witness "witness T-misrouted: a message is refused as misrouted" "misrouted")))))
