;; Planted bug: what xln.ts does at the peer-reachable `invariant(...)` sites (J-range rejections,
;; runtimeOutputTx authority errors, fatal openAccount). An invalid input from a peer halts the
;; Runtime instead of being rejected in place.
(define apply-input
  (rule "apply" (w side)
    (when (and (pair? (:queue w)) (not (:staged w)) (not (:halted w)) (not (:crashed w))))
    (then (let ((i (car (:queue w))))
            (if (or (equal? (kind i) "fatal") (equal? (kind i) "bad"))
                (-> w (assoc-in (list :halted) #t) (assoc-in (list :halt-cause) (kind i))
                      (update-in (list :queue) cdr))
                (fatal-free w i))))))
(define rules (list apply-input commit flush crash recover tick-clock))
(define (next w) (successors rules sides w))
