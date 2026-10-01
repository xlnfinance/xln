;; Planted bug: a peer-reachable invariant that halts the receiver, the pattern of og issues 1, 3, 4, 6, 7, 8 (there the
;; trigger is a content race: a settle update, a cancel against a fill, a repay after its due time, a view change). Here the trigger
;; is a frame that arrives ahead of its turn, which plain reordering produces. A halted node takes no further step.
(define (receive-frame w m)
  (let ((h (m-h m)) (n (length (:applied w))))
    (cond ((= h (+ n 1)) (hold w m))
          ((<= h n) (put-ack w n))
          (else (assoc-in w (list :halted) "b")))))
