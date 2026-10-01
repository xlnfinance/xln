;; Planted bug: a duplicate of the frame at my head is ignored instead of acked again, so a
;; lost ack wedges the proposer forever.
(define (reack? r f) #f)
