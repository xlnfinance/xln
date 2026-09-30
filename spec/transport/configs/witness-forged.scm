;; Witness: a forged message is on the link, so some delivery refuses it ("forged"). Adds an invariant that says it never happens;
;; the check must FAIL on it. It shows the refusal path is reachable, so its properties are not vacuous.
(define transport
  (assoc-in transport (list :invariants)
            (append invariants
                    (list (property "witness T-forged: a message is refused as forged" (w)
                            (not (find (lambda (m) (equal? (m-sig m) "forged")) (:chan w))))))))
