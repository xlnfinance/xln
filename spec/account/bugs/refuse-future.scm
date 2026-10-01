;; Planted bug: a frame stamped ahead of the receiver's clock by more than a tolerance is refused.
;; A payer with a fast clock, or a Byzantine one, gets a signed frame refused (R-CLOCK, part 1).
(define (refused-for-stamp? w stamp) (> stamp (+ (own-now w :right) max-skew)))
