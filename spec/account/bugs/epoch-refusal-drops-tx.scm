;; Planted bug (R-FRAME-EPOCH): a wrong_epoch refusal is judged like a refusal of a tx: the proposer drops the txs of the frame
;; the receiver never looked at.
(define (judged-nothing) (list :stale_attempt :stale_slot))
