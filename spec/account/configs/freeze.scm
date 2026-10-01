;; R-COSIGN-FREEZE: the two sides co-sign a settlement over the head they share (the fold signed is its offdelta), with a frame of each side in
;; the world: Left's p and Right's x both move offdelta. A frame still in flight when the settlement is signed reaches a frozen receiver, which
;; refuses it as `frozen` (retryable); the proposer takes it back and retries once the operation has landed or lapsed. Clock off.
(define left-txs  (vector "p"))
(define right-txs (vector "x"))
(define pay-txs   (vector "p" "x"))
(define conflicts (vector))
(define max-clock 0)
(define max-settles 1)
