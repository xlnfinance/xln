;; Planted bug (R-FRAME-EPOCH): the receiver writes a wrong_epoch refusal into its mark, as a refusal of a tx is. The frame was never
;; judged, yet the attempt is used up: a resend of the very same frame, once the contexts agree, is answered from the mark.
(define (refuse-epoch r f)
  (refuse (remember r f 0 :wrong_epoch) f 0 :wrong_epoch (:attempt f)))
