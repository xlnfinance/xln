;; Planted bug: what xln.ts does today. After an abort the Entity signs the replacement at the chain
;; nonce + 1, the nonce of the batch it abandoned: two different batches signed at one nonce. The
;; abandoned one may still land (it never expires), and the replacement then fails or lands twice.
(define (fresh-nonce w) (+ (:chain-nonce w) 1))
