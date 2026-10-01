;; Planted bug: the frame validator ignores the txs ahead of a tx inside the same frame, so a frame
;; can hold two conflicting txs (loaded with the same-side-conflict config).
(define (frame-fault view before txs)
  (let loop ((rest txs) (i 0))
    (if (null? rest)
        #f
        (let ((fault (tx-fault view before (car rest))))
          (if fault (cons i fault) (loop (cdr rest) (+ i 1)))))))
