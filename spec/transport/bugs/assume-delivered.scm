;; Planted bug: the sender counts a frame as held by the peer once it has left (exactly-once delivery assumed), so it never
;; resends a frame the link lost, and its belief runs ahead of the peer's.
(define (send-frame w h)
  (assoc-in (if (equal? (:dir w) "b")
                (put w (msg "frame" "a" "b" h (sendable-body w h) "ok"))
                (refuse w "misrouted"))
            (list :acked) h))
