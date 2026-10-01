;; Planted bug: a tx is checked against the Account as it was BEFORE the frame, not against the
;; txs already staged in it (the "two views" reading of lessons Q-E1). Two payments that each fit
;; are both admitted and together exceed the room.
(define (room w a)
  (- (+ cap (get-in w (list a :credit)))
     (+ (get-in w (list a :out)) (get-in w (list a :pending)))))
