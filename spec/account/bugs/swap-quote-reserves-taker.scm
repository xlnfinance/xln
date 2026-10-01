;; Planted bug (R-SWAP-CONSENT): a quote reserves the taker's want as well as the maker's give. A maker can lock the
;; taker's room with a quote the taker has never seen or accepted.
(define (quote-reserve held i m) (reserve-offer held i (:give m) (:want m) 1))
