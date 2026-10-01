;; The first page's bound, kept as a config: no clock, Left's "a" and Right's "x" and "y" with "a" before "x" invalid, one lost and one
;; repeated message. The conflicts, the tie-break and the re-ack are observed here (the default world is the clock world).
(define left-txs  (vector "a"))
(define right-txs (vector "x" "y"))
(define conflicts (vector (vector "a" "x")))
(define max-losses 1)
(define max-dups 1)
(define max-reflect 0)
(define max-clock 0)
