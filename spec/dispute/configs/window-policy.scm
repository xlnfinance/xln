;; N3: a signing policy that LENGTHENS the response windows inside the epoch. Frames from nonce 3 on carry windows one
;; longer than the floor (the base signs everything at the floor), the clock is 3 so a start from a long-window proof
;; still fits, and the settlement path puts its post frame (nonce 4 or 5) on the long windows too. A stale start at the
;; floor (an early frame, or the implicit proof) is then answered by a counter that lengthens the windows, which E9
;; allows; a start with a long-window proof can only be answered by frames that are at least as long.
(define max-time 3)
(define (frame-extra nonce) (if (>= nonce 3) 1 0))
