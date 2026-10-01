;; Planted bug (R-PROOF-NONCE-ABOVE-SIGNED, Review B of PR 97, finding 1): the two sides' slots are in one lane, so both propose at the same slot.
;; Right yields to Left's frame and signs it at a slot it already signed its own frame at: one signer, two proofs at one nonce.
(define (lane author) 0)
