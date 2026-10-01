;; A bound for the J page: gas by batch kind (coordinator, 09-30 16:12). A deposit leg and a money-only payment, one
;; relayer each, twice given too little gas or just the floor (`gas-starves` 2). A starved payment batch emits BatchGasStarved,
;; the transaction succeeds and the nonce is not spent; a starved deposit batch reverts whole and emits nothing. At the
;; floor the batch runs. No abort. Loaded after j/batch.scm.
(define ops (vector "x1" "r1"))
(define max-aborts 0)
(define gas-starves 2)
(define j-batch
  (dict :init (-> init (assoc-in (list :unsent) (list "x1" "r1")) (assoc-in (list :gas) 2))
        :next next :invariants invariants :at-rest (list) :goal finished?))
