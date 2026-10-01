;; An explicit-state checker for any spec of the shape
;;   (dict :init world
;;         :next (world -> list of (dict :label :world))
;;         :invariants (list of property)     ; hold in every reachable world
;;         :at-rest (list of property)        ; hold where no rule applies
;;         :steps (list of step-property)     ; optional: hold for every transition (world, rule name, side, next world)
;;         :goal (world -> bool))             ; optional: "done"
;; Breadth-first, so a counterexample trace is a shortest one.
;;
;; With :goal, the checker also proves that from EVERY reachable world some goal world
;; is still reachable (nothing can wedge the protocol). That is liveness without a
;; fairness model: the adversary may lose or duplicate messages, but can never make
;; completion impossible.
;;
;; (check spec)          -> (dict :ok #t :states n :transitions n :goals n) or a violation
;; (goal-traces spec n)  -> up to n complete runs, each a list of (dict :label :world)

;; ---- world identity: a string of the world, walking dicts in insertion order.
;; Worlds are built from `init` by updating existing keys (assoc-in / update-in), which
;; keeps that order stable, so equal worlds print equal. A page must therefore declare
;; every key in `init`. `canon-sorted` is the order-independent form (about 3x slower).
(define (canon-sorted v)
  (cond ((dict? v) (str "{" (string-join (sort (map (lambda (k) (str k " " (canon (dict-ref v k)))) (dict-keys v)) string<?) ",") "}"))
        ((pair? v) (str "(" (string-join (map canon v) ",") ")"))
        ((null? v) "()")
        ((string? v) (str "\"" v "\""))
        (else (str v))))

(define (canon v)
  (cond ((dict? v) (reduce (lambda (k acc) (str acc k " " (canon (dict-ref v k)) ",")) "{" (dict-keys v)))
        ((pair? v) (reduce (lambda (x acc) (str acc (canon x) ",")) "(" v))
        ((null? v) "()")
        ((string? v) (str "\"" v "\""))
        (else (str v))))

;; ---- the reachable graph, kept in flat cons lists
;; A dict that holds worlds or traces is re-walked on every insert (the first version was
;; quadratic in the size of the worlds), so the graph lives in lists and loop variables:
;;   seen  = list of (world-key . idx)      looked up with the native `assoc`
;;   recs  = list of (list idx parent label world), newest first
;;   edges = list of (from-idx . to-idx)
(define (rec-idx r) (car r))
(define (rec-parent r) (cadr r))
(define (rec-label r) (caddr r))
(define (rec-world r) (cadddr r))
(define (rec-at recs n idx) (list-ref recs (- n (+ idx 1))))

(define (broken props w) (find (lambda (p) (not ((:holds p) w))) props))

;; step properties look at a transition: (:holds p) takes the world, the rule's name, the side
;; that acted and the next world. They see what a rule DID, which no property of a world can.
(define (steps-of spec) (if (dict-has-key? spec :steps) (:steps spec) (list)))
(define (broken-step props w s)
  (find (lambda (p) (not ((:holds p) w (:name s) (:side s) (:world s)))) props))
;; the first successor that breaks a step property, as (property . successor), or #f
(define (first-broken-step props w succ)
  (if (null? props)
      #f
      (let scan ((ss succ))
        (if (null? ss)
            #f
            (let ((p (broken-step props w (car ss))))
              (if p (cons p (car ss)) (scan (cdr ss))))))))

;; oldest first, root included
(define (path recs n idx)
  (let up ((r (rec-at recs n idx)) (acc (list)))
    (if (< (rec-parent r) 0)
        (cons r acc)
        (up (rec-at recs n (rec-parent r)) (cons r acc)))))

(define (violation name recs n idx)
  (let ((steps (path recs n idx)))
    (dict :ok #f :violated name
          :trace (map rec-label (cdr steps))
          :state (rec-world (car (reverse steps))))))

;; a step property broken by the transition from world idx to `s`: the trace ends with that step
(define (step-violation name recs n idx s)
  (let ((steps (path recs n idx)))
    (dict :ok #f :violated name
          :trace (append (map rec-label (cdr steps)) (list (:label s)))
          :state (:world s))))

;; One breadth-first level: every frontier entry (list idx world) is checked, then its
;; successors are folded in. Returns the next graph, or (dict :bad violation).
(define (level-step spec frontier seen recs edges n transitions)
  (let nodes ((entries frontier) (seen seen) (recs recs) (edges edges) (n n)
              (tr transitions) (fresh (list)))
    (if (null? entries)
        (dict :bad #f :seen seen :recs recs :edges edges :n n :tr tr :fresh (reverse fresh))
        (let* ((idx  (car (car entries)))
               (w    (cadr (car entries)))
               (succ ((:next spec) w))
               (bad  (or (broken (:invariants spec) w)
                         (and (null? succ) (broken (:at-rest spec) w))))
               (bad-step (and (not bad) (first-broken-step (steps-of spec) w succ))))
          (if (or bad bad-step)
              (dict :bad (if bad
                             (violation (:name bad) recs n idx)
                             (step-violation (:name (car bad-step)) recs n idx (cdr bad-step))))
              (let steps ((ss succ) (seen seen) (recs recs) (edges edges) (n n) (fresh fresh))
                (if (null? ss)
                    (nodes (cdr entries) seen recs edges n (+ tr (length succ)) fresh)
                    (let* ((s   (car ss))
                           (key (canon (:world s)))
                           (hit (assoc key seen)))
                      (if hit
                          (steps (cdr ss) seen recs (cons (cons idx (cdr hit)) edges) n fresh)
                          (steps (cdr ss)
                                 (cons (cons key n) seen)
                                 (cons (list n idx (:label s) (:world s)) recs)
                                 (cons (cons idx n) edges)
                                 (+ n 1)
                                 (cons (list n (:world s)) fresh))))))))))) 

;; the whole reachable graph (or the first violation)
(define (explore spec)
  (let ((w0 (:init spec)))
    (let level ((frontier (list (list 0 w0)))
                (seen (list (cons (canon w0) 0)))
                (recs (list (list 0 -1 "init" w0)))
                (edges (list))
                (n 1)
                (transitions 0))
      (if (null? frontier)
          (dict :ok #t :recs recs :edges edges :n n :transitions transitions)
          (let ((step (level-step spec frontier seen recs edges n transitions)))
            (if (:bad step)
                (:bad step)
                (level (:fresh step) (:seen step) (:recs step) (:edges step) (:n step) (:tr step))))))))

;; ---- liveness: every reachable world can still reach a goal world
;; `alive` is a number whose i-th binary digit says "world i can reach a goal" (exact
;; integers are unbounded, so it is a bitset). One backwards sweep over the edge list
;; (newest edges first) repeats until nothing changes.
(define (bit i) (expt 2 i))
(define (has-bit? set i) (odd? (quotient set (bit i))))

(define (sweep edges alive)
  (reduce (lambda (e acc)
            (if (and (has-bit? acc (cdr e)) (not (has-bit? acc (car e))))
                (+ acc (bit (car e)))
                acc))
          alive
          edges))

(define (reaching edges goals)
  (let fix ((alive (reduce (lambda (i acc) (+ acc (bit i))) 0 goals)))
    (let ((next (sweep (:edges edges) alive)))
      (if (= next alive) alive (fix next)))))

(define (goal-idxs spec g)
  (map rec-idx (filter (lambda (r) ((:goal spec) (rec-world r))) (reverse (:recs g)))))

(define (stuck spec g)
  (let* ((goals (goal-idxs spec g))
         (alive (reaching g goals))
         (bad   (find (lambda (r) (not (has-bit? alive (rec-idx r)))) (reverse (:recs g)))))
    (if bad
        (violation "can always still finish" (:recs g) (:n g) (rec-idx bad))
        (dict :ok #t :goals (length goals)))))

(define (check spec)
  (let ((g (explore spec)))
    (if (not (:ok g))
        g
        (let ((live (if (dict-has-key? spec :goal) (stuck spec g) (dict :ok #t))))
          (if (not (:ok live))
              live
              (dict :ok #t :states (:n g) :transitions (:transitions g)
                    :goals (if (dict-has-key? spec :goal) (:goals live) 0)))))))

(define (goal-traces spec n)
  (let* ((g  (explore spec))
         (ks (goal-idxs spec g)))
    (map (lambda (i) (map (lambda (r) (dict :label (rec-label r) :world (rec-world r)))
                          (path (:recs g) (:n g) i)))
         (take ks (min n (length ks))))))

;; every rule that applies to a side, as labelled successors
(define (successors rules sides w)
  (append-map (lambda (side)
                (->> rules
                     (filter (lambda (r) ((:when r) w side)))
                     (map (lambda (r) (dict :label (str (:name r) " " side) :name (:name r) :side side :world ((:then r) w side))))))
              sides))
