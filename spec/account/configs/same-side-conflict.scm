;; A second bound for the frames page: Right's own txs conflict ("x" then "y"), so one frame can hold a
;; tx that conflicts with the tx AHEAD of it in the same frame. It makes the validator's handling of a
;; frame's own earlier txs observable (bug `frame-order`, the second review's a6).
(define conflicts (vector (vector "a" "x") (vector "x" "y")))
