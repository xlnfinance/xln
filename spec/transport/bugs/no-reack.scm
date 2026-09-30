;; Planted bug: the receiver drops a duplicate frame without answering. One lost ack and the sender never learns that the
;; peer holds the frame; it resends for ever.
(define (receive-frame w m)
  (let ((h (m-h m)) (n (length (:applied w))))
    (cond ((= h (+ n 1))
           (put-ack (update-in w (list :applied) (lambda (l) (append l (list (m-body m))))) h))
          ((<= h n) w)
          (else (refuse w "future")))))
