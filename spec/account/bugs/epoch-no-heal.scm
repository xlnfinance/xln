;; Planted bug (R-FRAME-EPOCH-WEDGE): the Runtime never closes the epoch. Two replicas that read the same epoch under two stored
;; nonces refuse each other's frames for good, and the Account never finishes.
(define max-closes 0)
