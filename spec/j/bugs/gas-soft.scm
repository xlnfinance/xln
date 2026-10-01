;; Planted bug: gas starvation is reported as an ordinary failure: the batch takes its nonce and emits BatchFailed
;; (coordinator, 23:42). A relayer that under-gasses the ERC-1271 stipend burns the Entity's nonce and gets its
;; batch declared failed for a reason the batch never had.
(define (gas-hard? w b) #f)
