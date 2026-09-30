;; Planted bug: the sender puts a frame on the link as soon as it is built, before its row is committed (R-DURABLE).
;; The receiver holds it and commits it; the sender crashes, builds frame 1 again (another body: it carries the crash count)
;; and commits that. The peer holds a frame the sender does not have and that contradicts the one it does: an equivocation.
(define (sendable-body w h)
  (cond ((<= h (length (:wal w))) (list-ref (:wal w) (- h 1)))
        ((and (= h (+ (length (:wal w)) 1)) (:staged w)) (:staged w))
        (else #f)))
