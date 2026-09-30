;; Planted bug: what og does at its peer-reachable invariants (og issues 1, 3, 4, 6, 7, 8). A frame that arrives ahead of
;; its turn, which plain reordering produces, halts the receiver.
(define (receive-frame w m)
  (let ((h (m-h m)) (n (length (:applied w))))
    (cond ((= h (+ n 1))
           (put-ack (update-in w (list :applied) (lambda (l) (append l (list (m-body m))))) h))
          ((<= h n) (put-ack w n))
          (else (assoc-in w (list :halted) "b")))))
