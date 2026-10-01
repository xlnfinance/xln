;; Planted bug: the receiver does not compare its own recomputation with the proposer's body; it
;; signs whatever it computed. Its computation disagrees by one unit of offdelta, so the two sides
;; hold proofs of different bodies for one nonce.
(define (receiver-body tip op nonce proposer)
  (let ((p (apply-op tip op nonce proposer #f)))
    (and p (make-proof nonce proposer (+ (p-off p) 1) (p-clause p) #f))))
(define (receiver-accepts? mine theirs) (and mine theirs #t))
