;; Planted bug: the first, symmetric H3 clamp (found in review of PR #42): retired evidence is clamped to
;; [0, collateral] on both ends, so a debtor erases what it owes a rotating entity by racing the rotation.
(define (clamp-retired retired delta collateral)
  (if (equal? retired :none) delta (max 0 (min collateral delta))))
