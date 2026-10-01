;; Planted bug (R-FRAME-EPOCH): the receiver does not compare the frame's epoch and first nonce with its own pair: a frame sealed
;; under another context is judged like any other and committed. The proof it carries was signed under an epoch the receiver does
;; not sign under.
(define (sealed-here? r f) #t)
