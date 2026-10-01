;; The epoch page without its step properties: what a replica committed must still be sealed under the pair it signs under
;; (`epoch-accepts-wrong`: the world property R-FRAME-EPOCH, not the refusal step, has to see a frame of another context committed).
(define account-frames (dict :init init :next next :invariants invariants :steps (list) :at-rest at-rest :goal done?))
