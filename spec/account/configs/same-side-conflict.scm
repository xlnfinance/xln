;; A second bound for the frames page: Right's own txs conflict ("x" then "y"), so one frame can hold a
;; tx that conflicts with the tx AHEAD of it in the same frame. It makes the validator's handling of a
;; frame's own earlier txs observable (bug `frame-order`, the second review's a6). No clock: the world is the
;; first page's, so the counts can be set against the kernel thread's replay of the attempt rule (QUESTIONS Q-A-12).
(define left-txs  (vector "a"))
(define right-txs (vector "x" "y"))
(define conflicts (vector (vector "a" "x") (vector "x" "y")))
(define max-losses 1)
(define max-dups 1)
(define max-reflect 0)
(define max-clock 0)
