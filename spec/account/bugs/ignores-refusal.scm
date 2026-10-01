;; Planted bug (R-FRAME-REFUSAL): the proposer ignores a refusal of its pending frame. The frame stays pending, the receiver
;; refuses its resend again (the same attempt, the same mark), and when it is Left's frame the peer's own frame is kept
;; out too: the Account wedges for good once the clock has moved past what the frame needs.
(define (on-refusal r m) (ignore r))
