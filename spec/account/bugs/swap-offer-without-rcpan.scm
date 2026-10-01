;; Planted bug (R-SWAP-OFFER): an offer is kept without asking whether RCPAN holds with its reservations. With no
;; credit either way the two offers exclude each other (see configs/swap-no-credit.scm); here the second is accepted, and
;; a fill could ask a side for funds it does not have.
(define (offer-enabled? w side i)
  (and (equal? side (maker-of i)) (not (book-of w i)) (<= (:now w) max-offer-now)))
