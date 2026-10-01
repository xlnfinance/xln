;; Witness: a message is refused as "future" in some run: a frame from the future is delivered ("future"). Loaded after transport/configs/recording-refuse.scm. It adds an
;; invariant that says this never happens; the check must FAIL on it (the trace is a reordering: frame 2 is sent and delivered while frame 1 is not yet taken). It shows the refusal branch RUNS,
;; so the properties around it are not vacuous.
(define transport
  (assoc-in transport (list :invariants)
            (append invariants
                    (list (witness "witness T-future: a message is refused as future" "future")))))
