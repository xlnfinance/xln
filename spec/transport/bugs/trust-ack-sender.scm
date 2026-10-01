;; Planted bug: the sender believes the sender field of an ack and does not check the signature. A stranger's ack makes the
;; sender believe the peer holds a frame it never applied, and the sender stops resending it.
(define (ack-authentic? m) #t)
