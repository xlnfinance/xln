;; Planted bug (R-SWAP-WITHDRAW): a withdraw returns the amounts OFFERED, not the remainder. After a partial fill it
;; releases reservations the offer no longer holds, and they were counted for another offer.
(define (withdraw-returns i o) (list (:give (menu-ref i)) (:want (menu-ref i))))
