;; Witness: a frame from the future is on the link, so some delivery refuses it ("future"). Adds an invariant that says it never
;; happens; the check must FAIL on it, with the trace that reaches it (a reordering: frame 2 sent, frame 1 not yet taken). It shows the
;; refusal path is reachable, so its properties are not vacuous.
(define transport
  (assoc-in transport (list :invariants)
            (append invariants
                    (list (property "witness T-future: a message is refused as future" (w)
                            (not (find (lambda (m) (and (equal? (m-kind m) "frame") (equal? (m-sig m) "ok")
                                                       (> (m-h m) (+ (length (:applied w)) 1))))
                                      (:chan w))))))))
