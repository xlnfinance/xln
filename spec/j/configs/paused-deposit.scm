;; A bound for the J page: the deposit funds the payment, and the token is paused once (coordinator, 09-30 13:50).
;; The reserve is empty, so the payment r1 waits for the deposit x1. While the token is paused the deposit is not signed
;; (it would only revert) and the payment is not covered, so nothing is signed and no nonce is spent; when the token
;; resumes the deposit goes alone, then the payment. No abort. Loaded after j/batch.scm.
(define ops (vector "x1" "r1"))
(define max-aborts 0)
(define pauses 1)
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "x1" "r1")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0))
        :next next :invariants invariants :at-rest (list) :goal finished?))
