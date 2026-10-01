;; Planted bug (R-RETRY-NEW-NONCE, R-PROOF-NONCE-ABOVE-SIGNED): a retry signs its proof at the SAME nonce as the refused attempt, base + 1,
;; whatever the attempt. The refused attempt's proof exists (it was signed), so the committed retry shares its nonce with a
;; different proof of the same signer: two proofs of one nonce, one of them never committed.
(define (proposal-nonce r) (+ (base-nonce r) 1))
