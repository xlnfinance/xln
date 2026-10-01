;; Planted bug: a list exactly at the cap reverts; the contract reverts only above it (E10).
(define (forgive-over-cap? ids) (>= (length ids) forgive-cap))
