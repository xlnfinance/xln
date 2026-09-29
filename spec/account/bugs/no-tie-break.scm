;; Planted bug: both sides yield to the peer (no tie-break).
(define (on-frame side r f)
  (if (not (equal? (:prev f) (:head r)))
      (dict :replica r :sent (list (fault "frame does not extend head")))
      (dict :replica (commit (if (:pending r) (roll-back r) r) (frame-hash f))
            :sent    (list (ack-msg (frame-hash f))))))
