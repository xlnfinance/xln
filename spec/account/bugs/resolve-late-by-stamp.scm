;; Planted bug: the payer decides a secret resolve by the frame's stamp too. A payee (or a skewed clock)
;; that stamps its resolve with a late height gets a resolve refused inside the deadline.
(define (resolve-late? w stamp) (or (> (own-now w :left) lock-deadline) (> stamp lock-deadline)))
