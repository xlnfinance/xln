;; A bound for the J page: R-FUNDED without any deposit (coordinator, 09-30 15:23, "in every situation"). The reserve is
;; empty and one payment is queued. Nothing may be signed: an unfunded payment would soft-fail and burn a nonce every
;; round. The goal: the payment waits in the draft and nothing was signed. Loaded after j/batch.scm.
(define ops (vector "r1"))
(define max-aborts 0)
(define (waits-unsigned? w)
  (and (null? (:unsent w)) (equal? (:draft w) (list "r1")) (null? (:signed w)) (equal? (:phase w) :idle)))
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "r1")) (assoc-in (list :reserve) 0) (assoc-in (list :seed) 0))
        :next next :invariants invariants :at-rest (list) :goal waits-unsigned?))
