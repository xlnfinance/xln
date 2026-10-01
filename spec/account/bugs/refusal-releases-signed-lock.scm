;; Planted bug (R-SIGNED-IS-LIVE): a refusal releases the payer's hold on a lock at once, while the peer still holds the proof
;; the proposer signed with that lock in it. The peer can enforce it on chain: the hold is gone and the lock is still live.
(define (holds-signed? r tx) #f)
