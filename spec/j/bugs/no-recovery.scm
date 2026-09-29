;; Planted bug: what xln.ts does on a non-hub Entity. A quarantined batch is never recovered
;; automatically (only a manual abort or clear); the Entity is stuck.
(define recover
  (rule "recover" (w side)
    (when #f)
    (then w)))
