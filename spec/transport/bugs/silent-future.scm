;; Not a protocol bug but a probe of the witnesses: the receiver drops a frame from the future without calling `refuse`. Safety and
;; liveness are unharmed, so only a witness that checks the refusal RAN can see the difference: with transport/configs/recording-refuse.scm
;; and witness-future.scm the check must now PASS (the witness never fires).
(define (receive-frame w m)
  (let ((h (m-h m)) (n (length (:applied w))))
    (cond ((= h (+ n 1)) (hold w m))
          ((<= h n) (put-ack w n))
          (else w))))
