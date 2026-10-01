;; Planted bug (lesson #37, R3): a dispute op by the payee leaves the secret out of the calldata. The
;; payee knows it, acts before the deadline, and still loses the clause when the deadline passes.
(define (publish-secret w) w)
