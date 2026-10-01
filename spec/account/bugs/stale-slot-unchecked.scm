;; Planted bug (R-PROOF-NONCE-ABOVE-SIGNED): a replica with no frame out acks a slot at or below a proof it signed and left behind: the frame it
;; took back (a refusal, a yield) is still a signed proof, so the committed frame lands below it. Without `stale_slot` nothing stops the
;; receiver acking it.
(define (stale-slot? r f) #f)
