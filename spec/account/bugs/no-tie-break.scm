;; Planted bug: both sides yield to the peer's frame (no tie-break), so a collision
;; commits two different frames at the same height.
(define (keeps-own? side r) #f)
