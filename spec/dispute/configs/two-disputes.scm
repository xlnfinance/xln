;; A second dispute after a dispute (round 2, `max-disputes` 2) at reduced bounds: a script of ONE frame, no rival, no
;; cooperative settlement, a clock of 4 so both windows fit (a dispute lasts 2). The first dispute ends the epoch;
;; the second starts from the pre-signed baseline the parties co-signed with every frame, so the baseline is
;; actually PRESENTED, which the one-dispute base never does. Finding Q-D-21: the second advance has no proof.
(define max-disputes 2)
(define max-time 4)
(define settle-heights (vector))
(define rivals (list))
(define script
  (list (list :right (list :pay :right 1))))
