;; A second dispute after a dispute (round 2, `max-disputes` 2) at reduced bounds: a script of ONE frame, no rival, no
;; cooperative settlement, a clock of 4 so both windows fit (a dispute lasts 2). The first dispute ends the epoch;
;; the second starts from the IMPLICIT proof of the new epoch (R-IMPLICIT-BASELINE, Q-D-21, decision D2: empty
;; signature, Right-authored, nonce = the chain nonce + 1), so the proof is actually PRESENTED, which the one-dispute
;; base never does. A deposit inside the new epoch (a Left deposit raises ondelta) is explored before the second dispute.
(define max-disputes 2)
(define max-time 4)
(define settle-heights (vector))
(define rivals (list))
(define script
  (list (list :right (list :pay :right 1))))
