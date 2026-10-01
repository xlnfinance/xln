;; Planted bug: the receiver assumes the link keeps the order, so a frame ahead of its head is applied as the next one.
;; Frame 2 delivered before frame 1 takes frame 1's place.
(define (receive-frame w m)
  (let ((h (m-h m)) (n (length (:applied w))))
    (if (>= h (+ n 1))
        (put-ack (update-in w (list :applied) (lambda (l) (append l (list (m-body m))))) (+ n 1))
        (put-ack w n))))
