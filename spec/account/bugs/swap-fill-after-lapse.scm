;; Planted bug (R-SWAP-EXPIRE): a lapsed offer stays fillable, as if the lapse only removed the reservation.
(define (fillable? w o)
  (or (and (open? o) (<= (:now w) (:deadline o)))
      (equal? (:status o) :lapsed)))
