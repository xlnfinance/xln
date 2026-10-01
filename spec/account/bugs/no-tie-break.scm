;; Planted bug: both sides yield to the peer's frame (no tie-break), so a collision
;; commits two different frames at the same height.
(define (on-frame side r f)
  (cond ((equal? (:prev f) (:head r)) (accept r f))
        ((equal? (frame-hash f) (:head r)) (dict :replica r :sent (list (ack-msg (frame-hash f)))))
        (else (ignore r))))
