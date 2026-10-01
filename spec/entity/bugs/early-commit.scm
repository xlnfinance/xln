;; Planted bug: a frame commits one signature short of the quorum. With quorum 3 of 3 the second signer commits at
;; once, as under quorum 2, and the third validator never signed it.
(define (reached? n) (>= n (- quorum 1)))
