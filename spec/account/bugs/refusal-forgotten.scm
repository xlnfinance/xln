;; Planted bug (attempt number): the receiver does not keep its refusal (the mark is forgotten at once). A frame it refused
;; is judged afresh when it arrives again; once the receiver's view has moved it commits the very frame whose proposer
;; already took it back. Meanwhile the proposer's peer committed another frame at the same head: the replicas fork.
(define (remember r f index fault) r)
