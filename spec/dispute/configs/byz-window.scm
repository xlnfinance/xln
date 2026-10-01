;; N3 / E9 against a BYZANTINE signer (review round 3 of PR 41: `counter-shortens-window` dies at the signing guard, so the
;; chain's E9 check was dead code in the model). Two Right frames, the second (nonce 2) on windows one longer than the floor, a
;; clock of 4 so a start from it still fits, no rival and no settlement. Right may also sign ALONE a proof with the FLOOR windows
;; on top of the newest committed state (`byz-window`): Left holds a proof no one co-signed, so no signing guard ever sees it.
;; A start from the long-window frame is then answered by that proof only if E9 lets a counter shorten the windows.
(define max-time 4)
(define (frame-extra nonce) (if (>= nonce 2) 1 0))
(define settle-heights (vector))
(define rivals (list))
(define script
  (list (list :right (list :pay :right 1))
        (list :right (list :pay :right 1))))
(define max-byz-windows 1)
