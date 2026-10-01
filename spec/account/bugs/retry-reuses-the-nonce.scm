;; Planted bug (R-RETRY-NEW-NONCE, R-PROOF-NONCE-ABOVE-SIGNED): a retry signs its proof at the slot of the attempt it retries: the proposer takes
;; the slot above what it knows the PEER signed and not above its own abandoned proof. The refused attempt's proof exists (it was signed), so the
;; committed retry shares its slot with a different proof of the same signer: two proofs at one nonce, one of them never committed.
(define (proposal-slot side r) (slot-above side (used-slot r) (max (used-slot r) (:peer-high r))))
