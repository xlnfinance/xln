;; Planted bug: a secret revealed after the deadline still pays.
(define (secret-public-by? w deadline) (and (:secret w) #t))
