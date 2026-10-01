;; Planted bug (R-FRAME-EPOCH): a wrong_epoch refusal is treated like a refusal of a tx: the proposer takes its frame back and
;; seals it anew, though its own context never moved. A resend costs a fresh proof instead of the same bytes.
(define (epoch-parks? r m) #f)
