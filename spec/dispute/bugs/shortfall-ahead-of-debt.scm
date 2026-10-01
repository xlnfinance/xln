;; Planted bug: the peer is paid out of the raw reserve, ahead of the debtor's older debts.
(define (payable w side) (get-in w (list :reserve side)))
