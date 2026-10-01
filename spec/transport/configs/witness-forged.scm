;; Witness: a message is refused as "forged" in some run: a forged message is delivered ("forged"). Loaded after transport/configs/recording-refuse.scm. It adds an
;; invariant that says this never happens; the check must FAIL on it (the trace is forge frame, deliver). It shows the refusal branch RUNS,
;; so the properties around it are not vacuous.
(define transport
  (assoc-in transport (list :invariants)
            (append invariants
                    (list (witness "witness T-forged: a message is refused as forged" "forged")))))
