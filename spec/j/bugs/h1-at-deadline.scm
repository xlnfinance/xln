;; Planted bug: the chain lets a finalize through at the deadline second itself (an off-by-one on the H1
;; boundary): the payee has until the deadline, inclusive, to show the secret.
(define (h1-wait-over? w) (or (:secret w) (>= (:now w) a-deadline)))
