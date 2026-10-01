;; Planted bug: a secret revealed AT the deadline second no longer pays (the contract pays when
;; revealedAt <= deadline).
(define (secret-public-by? w deadline) (and (:secret w) (< (:secret w) deadline)))
