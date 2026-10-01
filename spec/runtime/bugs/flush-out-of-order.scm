;; Planted bug: the Runtime flushes the NEWEST unsent output first. A peer receives the outputs of
;; frames out of the order they were committed in (R-DURABLE, output order).
(define flush
  (rule "flush" (w side)
    (when (and (pair? (unsent w)) (not (:crashed w))))
    (then (let ((o (row-output (car (reverse (unsent w))))))
            (-> w (update-in (list :sent) (lambda (s) (append s (list o))))
                  (update-in (list :received) (lambda (r) (if (member o r) r (append r (list o))))))))))
(define rules (list apply-input commit flush crash recover tick-clock))
(define (next w) (successors rules sides w))
