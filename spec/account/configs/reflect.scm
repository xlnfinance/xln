;; The link hands a replica its own frame back, as if the peer had sent it (R-FRAME-AUTHOR): Left's expire against Right's x, no loss, one reflection.
;; The author is in the frame and in its hash, and a replica refuses a frame it authored (bug `accepts-own-frame`).
(define left-txs  (vector "expire"))
(define right-txs (vector "x"))
(define conflicts (vector))
(define max-losses 0)
(define max-reflect 1)
