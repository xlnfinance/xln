;; The Account frames under a link that REORDERS (transport page Q-T-2): a replica may take any of the first four queued messages, not only the
;; head. Loss and duplication are as in the base page. This is the evidence for "the Account page stays correct under the weaker channel".
;; Loaded after account/frames.scm; it only changes `deliver`.
(define (drop-nth l k) (append (take l k) (list-tail l (+ k 1))))
(define (deliver-at k)
  (rule (str "deliver " k) (w side)
    (when (> (length (inbox-of w side)) k))
    (then (let ((out (receive side (side w) (list-ref (inbox-of w side) k))))
            (-> w (assoc-in (list side) (:replica out))
                  (update-in (list :inbox side) (lambda (q) (drop-nth q k)))
                  (enqueue (peer side) (:sent out)))))))
(define rules (list submit propose (deliver-at 0) (deliver-at 1) (deliver-at 2) (deliver-at 3) resend lose duplicate byz-frame))
