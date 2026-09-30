;; Planted bug: the sender puts a frame on the link as soon as it is built, before its row is committed (R-DURABLE).
;; A crash then drops the frame, the sender builds frame n+1 again with another body, and the receiver holds a frame the
;; sender does not have: an equivocation the peer cannot detect.
(define (sendable-body w h)
  (cond ((<= h (length (:wal w))) (list-ref (:wal w) (- h 1)))
        ((and (= h (+ (length (:wal w)) 1)) (:staged w)) (:staged w))
        (else #f)))
