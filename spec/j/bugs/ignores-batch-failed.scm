;; Planted bug: the Entity does not read BatchFailed (coordinator R-J5). The batch stays in flight and
;; its work is never re-queued, so a deposit in it is neither applied nor drafted again.
(define (observe-failure w e)
  (update-in w (list :chain-nonce) (lambda (n) (max n (:nonce e)))))
