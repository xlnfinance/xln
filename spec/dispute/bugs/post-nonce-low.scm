;; Planted bug (review B of PR 76, finding 3; "a Right-authored signed proof at stored + 1 loses to the implicit proof"):
;; the first signed frame of the new epoch takes its proof nonce from the chain nonce + 1 instead of + 2. It is
;; Right-authored, so it only TIES the implicit proof (rank = 2 * nonce + (Left ? 1 : 0)), a tie is a refused counter,
;; and a dispute opened from the implicit proof pays the empty state: the frame's offdelta (Left's money) is lost.
(define (post-nonce w) (+ 1 (:chain-nonce w)))
