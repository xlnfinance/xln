;; Planted bug: hooks and txs are folded in the order they arrived, so a wake's Account tx can
;; be queued after the frame's own txs (lessons R-E2).
(define (hooks is) (list))
(define (txs is) (filter (lambda (i) (or (equal? (kind i) "pay") (equal? (kind i) "wake"))) is))
