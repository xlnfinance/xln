;; An explicit-state checker for any spec of the shape
;;   (dict :init world
;;         :next (world → list of (dict :label :world))
;;         :invariants (list of property)
;;         :at-rest (list of property))    ; checked where no rule applies
;; Breadth-first, so a counterexample trace is a shortest one.

(define (broken props w) (find (lambda (p) (not ((:holds p) w))) props))

(define (violation prop node)
  (dict :ok #f :violated (:name prop) :trace (reverse (:trace node)) :state (:world node)))

;; the successors of node not seen yet → (dict :seen :fresh)
(define (expand node succ seen)
  (reduce (lambda (s acc)
            (if (member (:world s) (:seen acc))
                acc
                (dict :seen  (cons (:world s) (:seen acc))
                      :fresh (cons (dict :world (:world s) :trace (cons (:label s) (:trace node)))
                                   (:fresh acc)))))
          (dict :seen seen :fresh (list))
          succ))

(define (check spec)
  (let explore ((frontier (list (dict :world (:init spec) :trace (list))))
                (seen (list (:init spec)))
                (transitions 0))
    (if (null? frontier)
        (dict :ok #t :states (length seen) :transitions transitions)
        (let* ((node (car frontier))
               (w    (:world node))
               (succ ((:next spec) w))
               (bad  (or (broken (:invariants spec) w)
                         (and (null? succ) (broken (:at-rest spec) w)))))
          (if bad
              (violation bad node)
              (let ((step (expand node succ seen)))
                (explore (append (cdr frontier) (reverse (:fresh step)))
                         (:seen step)
                         (+ transitions (length succ)))))))))

;; every rule that applies to a side, as labelled successors
(define (successors rules sides w)
  (append-map (lambda (side)
                (->> rules
                     (filter (lambda (r) ((:when r) w side)))
                     (map (lambda (r) (dict :label (str (:name r) " " side) :world ((:then r) w side))))))
              sides))
