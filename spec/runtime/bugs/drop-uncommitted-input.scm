;; Planted bug: a crash between apply and commit forgets the input instead of getting it back from
;; the network; the input is neither committed nor queued.
(define crash
  (rule "crash" (w side)
    (when (and (not (:crashed w)) (< (:crashes w) max-crashes)))
    (then (-> w (update-in (list :crashes) (lambda (n) (+ n 1)))
                (assoc-in (list :crashed) #t)
                (assoc-in (list :state) (list)) (assoc-in (list :ts) 0) (assoc-in (list :height) 0)
                (assoc-in (list :staged) #f)))))
(define rules (list apply-input commit flush crash recover tick-clock))
(define (next w) (successors rules sides w))
