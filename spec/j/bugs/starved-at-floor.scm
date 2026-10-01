;; Planted bug: the floor itself counts as starved (`<=`, not `<`), so a batch given exactly budget*64/63 + 30,000 never runs.
(define (gas-starved? b supplied) (<= supplied (gas-floor)))
