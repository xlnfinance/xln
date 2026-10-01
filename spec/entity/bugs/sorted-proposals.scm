;; Planted bug: Accounts propose in ascending id order, not in the order the frame first touched
;; them (lessons R-E4).
(define (propose-order w touched)
  (filter (lambda (a) (eligible? w a)) account-ids))
