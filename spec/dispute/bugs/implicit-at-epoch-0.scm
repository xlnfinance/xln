;; Planted bug (review round 3 of PR 41, m4): the implicit proof is offered from epoch 0 on (the contract: epoch >= 1). At
;; epoch 0 the Account has signed proofs and no advance behind it: Right pays Left (n1R, Right-authored, rank 2), the implicit
;; proof at nonce 1 (Right-authored) ties it, Left's counter is refused as a tie, and a start from the empty state erases the
;; payment. Nothing noticed it until the tie property: "a dispute that settles on the implicit proof leaves no signed proof of
;; its epoch at or above it".
(define (implicit-proofs w) (list (implicit-proof w)))
