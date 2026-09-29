;; The spec vocabulary: rules and properties as named data.
;;
;;   (rule "propose" (w side) (when guard) (then next-world))
;;     → (dict :name :when (λ (w side) guard) :then (λ (w side) next-world))
;;   (property "name" (w) holds?)
;;     → (dict :name :holds (λ (w) holds?))

(define-syntax rule
  (syntax-rules (when then)
    ((_ name (w side) (when guard) (then next))
     (dict :name name
           :when (lambda (w side) guard)
           :then (lambda (w side) next)))))

(define-syntax property
  (syntax-rules ()
    ((_ name (w) holds)
     (dict :name name :holds (lambda (w) holds)))))
