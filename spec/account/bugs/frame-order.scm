;; Planted bug: the frame validator ignores the txs ahead of a tx inside the same frame, so a frame
;; can hold two conflicting txs (loaded with the same-side-conflict config).
(define (frame-valid? before txs)
  (every (lambda (tx) (tx-valid? before tx)) txs))
