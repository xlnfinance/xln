;; Planted bug: the shared payment arithmetic moves the allocation the wrong way (money/core.scm). The ledger
;; page and the dispute page both build their payments from it, so both must catch it.
(define (ledger-pay off payer amount) (if (equal? payer :left) (+ off amount) (- off amount)))
