;; Planted bug (R-SWAP-OFFER): a quote is kept without asking whether RCPAN holds with the maker's give. After a payment
;; that leaves the maker too little (no credit either way, configs/swap-no-credit.scm), the quote is still made, and a fill
;; could ask the maker for funds it does not have.
(define (offer-enabled? w side i)
  (and (equal? side (maker-of i)) (not (book-of w i)) (<= (:now w) max-offer-now)))
