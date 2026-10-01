;; Planted bug: a proof is usable whatever epoch it was signed for (the chain checks only the
;; nonce). After one dispute settles, an older proof with a higher nonce pays out again.
(define max-disputes 2)
(define (usable? w p) (> (p-nonce p) (:chain-nonce w)))
