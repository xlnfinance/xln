;; One tx (Left's p; Right has none: with Right's x as well the space was too large for one run) and no clock: the wedge and its heal need no more.
;; R-FRAME-EPOCH-WEDGE: the chain moves on to a higher epoch and then its stored nonce rises within it, so the two replicas can read
;; the SAME epoch under TWO stored nonces. A report of the same epoch is ignored, so neither view moves and each refuses the
;; other's frames for good: the Account wedges (safety holds: no head splits, no tx is lost). The Runtime that cannot get its peer
;; to sign closes the epoch on the chain (one step here, the dispute is the dispute page's), and both then read the chain's pair.
(define left-txs  (vector "p"))
(define right-txs (vector))
(define pay-txs   (vector "p"))
(define conflicts (vector))
(define max-clock 0)
(define max-epoch-moves 1)
(define max-nonce-ups 1)
(define max-closes 1)
