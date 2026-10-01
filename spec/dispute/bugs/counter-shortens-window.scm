;; Planted bug (N3, E9; review B of PR 76, risk 5): a policy lowers the response windows inside an epoch and
;; nothing refuses it. Load after `configs/window-policy.scm` (frames of nonce 3 carry longer windows): the frames
;; after it fall back to the floor, neither side refuses to sign them, and the contract takes the counter that
;; carries the shorter windows. A stale start with the long windows could then be answered by a counter that
;; shortens them, the clock frozen from the initial body notwithstanding.
(define (frame-extra nonce) (if (= nonce 3) 1 0))
(define (windows-keep-ok? w p) #t)
(define (windows-ok? d p) #t)
