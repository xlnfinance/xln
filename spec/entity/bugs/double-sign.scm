;; Planted bug: a validator that already signed its own proposal at this height signs a proposal
;; of another leader too. Two quorums can then form on two frames.
(define (on-prop w side m)
  (let ((r (side w)) (f (:frame m)))
    (if (and (>= (:view m) (:view r)) (certified-here? r f))
        (-> w (assoc-in (list side) (install (assoc-in r (list :view) (:view m)) f))
              (send (msgs-to side (lambda (to) (dict :kind :commit :frame f :to to)))))
        w)))
