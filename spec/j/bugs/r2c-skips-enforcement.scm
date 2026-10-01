;; Planted bug: a reserve payment does not enforce the outstanding debt first. The payment lands with the queue still full
;; and reserve left over that is not owed.
(define (r2c-enforce w) w)
