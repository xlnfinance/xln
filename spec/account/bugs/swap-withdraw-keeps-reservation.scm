;; Planted bug (R-SWAP-WITHDRAW): a withdraw removes the offer and its clause but not the reservations. RCPAN keeps
;; counting an offer that is gone, and then refuses a payment the Account has the room for.
(define (withdraw-returns i o) (list 0 0))
