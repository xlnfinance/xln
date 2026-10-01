;; Planted bug: the receiver acks a frame as soon as it arrives, before its own row is committed (R-DURABLE, the receiver's half).
;; A receiver crash then loses the frame the sender now believes the peer holds, and the sender never resends it.
(define (receive-frame w m)
  (let ((h (m-h m)) (n (length (:applied w))))
    (cond ((= h (+ n 1)) (put-ack (hold w m) h))
          ((<= h n) (put-ack w n))
          (else (refuse w "future")))))
