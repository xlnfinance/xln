;; Planted bug (R-PROOF-NONCE-ABOVE-SIGNED, Review B of PR 97, finding 3): a receiver believes any slot in the author's lane above the committed one,
;; with no limit on how far above. One frame from a Byzantine peer then moves the committed slot as far as it likes (the nonce space). Config slot-jump.
(define (honest-slot? r author slot)
  (and (> slot (used-slot r)) (= (modulo (- slot (used-slot r)) 2) (lane author))))
