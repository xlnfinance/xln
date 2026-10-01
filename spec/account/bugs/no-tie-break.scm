;; Planted bug: both sides yield to the peer's frame (no tie-break), so a collision commits two different frames at the same height.
;; Since the slots (R-PROOF-NONCE-ABOVE-SIGNED) the first yield already commits below the proof the yielder signed, so that is the property it is
;; caught by first; the fork follows one step later.
(define (keeps-own? side r f) #f)
