;; Planted bug (R-FRAME-EPOCH): a frame of another context is refused without noting the slot its author signed. What the receiver
;; proposes next may then sit at or below that slot: the proof it would sign is not above every nonce the peer signed.
(define (note-epoch-slot r f) r)
