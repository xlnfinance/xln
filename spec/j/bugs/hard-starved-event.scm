;; Planted bug: a starved batch with a deposit or dispute op is reported as BatchGasStarved. It runs in processBatch's own
;; frame and reverts whole: a reverted transaction cannot emit an event.
(define (starved-event? w b) #t)
