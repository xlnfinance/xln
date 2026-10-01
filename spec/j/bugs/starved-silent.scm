;; Planted bug: a starved money-only batch emits nothing: the Entity cannot tell a gas starvation from a batch that is still
;; travelling.
(define (starved-event? w b) #f)
