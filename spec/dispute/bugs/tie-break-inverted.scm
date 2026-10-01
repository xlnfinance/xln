;; Planted bug: at an equal nonce Right's proposal outranks Left's (the contracts say Left wins).
;; The proposal that lost the cross-open then beats the committed frame.
(define (rank id) (+ (* 2 (p-nonce id)) (if (equal? (p-proposer id) :right) 1 0)))
