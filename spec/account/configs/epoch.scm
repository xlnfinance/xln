;; R-FRAME-EPOCH: the chain moves on to a higher epoch while a frame of each side may be in flight. A replica that hears it first
;; refuses the other's frame as `wrong_epoch` before looking at any tx; the proposer parks the frame (the same bytes again on the
;; resend, no new proof), or, when its own view has moved since it sealed, takes the frame back and seals it anew. Two txs, no
;; conflict, no clock, as in freeze.scm.
(define left-txs  (vector "p"))
(define right-txs (vector "x"))
(define pay-txs   (vector "p" "x"))
(define conflicts (vector))
(define max-clock 0)
(define max-epoch-moves 1)
