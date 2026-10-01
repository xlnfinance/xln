;; Not a bug: a WIDENING of the page's link. The page's `deliver` takes the head of the inbox (FIFO). Quint's network is a set and
;; delivers any message in flight. This adds `deliver the n-th message` for n = 1 and 2, so the receiver may take any of the first three.
(define (deliver-nth n)
  (rule (str "deliver " n) (w side)
    (when (> (length (inbox-of w side)) n))
    (then (let* ((q (inbox-of w side))
                 (m (list-ref q n))
                 (out (receive side (side w) m)))
            (-> w (assoc-in (list side) (:replica out))
                  (assoc-in (list :inbox side) (append (take q n) (list-tail q (+ n 1))))
                  (enqueue (peer side) (:sent out)))))))
(define rules (list submit propose deliver resend lose duplicate byz-frame (deliver-nth 1) (deliver-nth 2)))
(define (next w) (successors rules sides w))
(define account-frames
  (dict :init init :next next :invariants invariants :at-rest at-rest :goal done?))
