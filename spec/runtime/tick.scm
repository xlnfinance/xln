;; The Runtime tick: what a frame does with one input, when its outputs may leave, and how a
;; crashed Runtime comes back. A description of pure/xln.ts `applyRuntime` (40856), `refuseInput`
;; (40449), `commitRuntimeFrame` (42045) and `recoverRuntime` (42158), and of lessons R-X1, R-X2.
;;
;;   apply    take the next input. A GOOD input changes the state; a peer-reachable BAD input is
;;            REJECTED in place (a rejection goes back to the peer) and never halts (R-X1); only a
;;            local-corruption input (FATAL) halts the Runtime, and then the frame is not committed.
;;            The frame timestamp is max(runtime timestamp, input timestamp): it never goes back.
;;   commit   the frame's WAL row is written: height, timestamp, input, output. Only now is the frame real.
;;   flush    outputs of COMMITTED rows leave, one at a time. Nothing leaves before its row is committed.
;;   crash    volatile state is lost; an input not yet committed comes back from the network.
;;   recover  replay every WAL row with the row's own timestamp (no clock, no randomness inside a
;;            transition); outputs of committed rows that never left are sent again.
;;
;; Abstractions: the state is the list of applied inputs with the timestamp each was applied at, the
;; hash of a frame is that state, the outbox digest is the output id; one Runtime, one Entity.
;;
;; Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable max-crashes (s/number) 1)
;; (id kind timestamp): kind is good | bad (a peer sent something invalid) | fatal (local corruption)
(define/overridable inputs (s/array (s/array (s/string)))
  (list (list "i1" "good" "2") (list "i2" "bad" "1") (list "i3" "good" "1") (list "i4" "fatal" "5")))

(define sides (list :runtime))
(define (input-of row) (list (car row) (cadr row) (string->number (caddr row))))
(define (id i) (car i))
(define (kind i) (cadr i))
(define (ts i) (caddr i))

;; a WAL row is (height timestamp input-id output-id state-entry-or-#f)
(define (row-height r) (car r))
(define (row-ts r) (cadr r))
(define (row-input r) (caddr r))
(define (row-output r) (cadddr r))
(define (row-entry r) (car (cddddr r)))

(define init
  (dict :queue (map (lambda (row) (input-of (vector->list row))) (vector->list inputs))
        :state (list) :ts 0 :height 0 :staged #f :wal (list)
        :committed-state (list) :sent (list)
        :crashed #f :crashes 0 :halted #f :halt-cause #f :clock 0))

(define (frame-ts w i) (max (:ts w) (ts i)))
(define (entry i t) (str (id i) "@" t))
(define (output-of i) (if (equal? (kind i) "good") (str "ok-" (id i)) (str "rej-" (id i))))

;; a row for input i, and whether it changes the state
(define (row-for w i)
  (let ((t (frame-ts w i)))
    (list (+ (:height w) 1) t (id i) (output-of i) (if (equal? (kind i) "good") (entry i t) #f))))
(define (applied w row)
  (if (row-entry row) (update-in w (list :state) (lambda (s) (append s (list (row-entry row))))) w))

(define apply-input
  (rule "apply" (w side)
    (when (and (pair? (:queue w)) (not (:staged w)) (not (:halted w)) (not (:crashed w))))
    (then (let ((i (car (:queue w))))
            (if (equal? (kind i) "fatal")
                (-> w (assoc-in (list :halted) #t) (assoc-in (list :halt-cause) "fatal")
                      (update-in (list :queue) cdr))
                (fatal-free w i))))))
;; what a non-halting input does
(define (fatal-free w i)
  (let ((row (row-for w i)))
    (-> (applied w row)
        (update-in (list :queue) cdr)
        (assoc-in (list :staged) row)
        (assoc-in (list :ts) (row-ts row)))))

(define commit
  (rule "commit" (w side)
    (when (and (:staged w) (not (:crashed w))))
    (then (-> w (update-in (list :wal) (lambda (l) (append l (list (:staged w)))))
                (assoc-in (list :committed-state) (:state w))
                (assoc-in (list :height) (row-height (:staged w)))
                (assoc-in (list :staged) #f)))))

;; outputs of committed rows leave, in order, once each
(define (unsent w) (filter (lambda (r) (not (member (row-output r) (:sent w)))) (:wal w)))
(define flush
  (rule "flush" (w side)
    (when (and (pair? (unsent w)) (not (:crashed w))))
    (then (update-in w (list :sent) (lambda (s) (append s (list (row-output (car (unsent w))))))))))

(define crash
  (rule "crash" (w side)
    (when (and (not (:crashed w)) (< (:crashes w) max-crashes)))
    (then (-> w (update-in (list :crashes) (lambda (n) (+ n 1)))
                (assoc-in (list :crashed) #t)
                (assoc-in (list :state) (list)) (assoc-in (list :ts) 0) (assoc-in (list :height) 0)
                ;; an input that was applied but not committed comes back from the network
                (update-in (list :queue) (lambda (q) (if (:staged w) (cons (staged-input w) q) q)))
                (assoc-in (list :staged) #f)))))
(define (staged-input w)
  (find (lambda (i) (equal? (id i) (row-input (:staged w)))) all-inputs))
(define all-inputs (map (lambda (row) (input-of (vector->list row))) (vector->list inputs)))

;; replay: the rows, each with its own timestamp
(define (replay-state w) (filter (lambda (e) e) (map row-entry (:wal w))))
(define (last-ts w) (if (null? (:wal w)) 0 (row-ts (car (reverse (:wal w))))))
(define recover
  (rule "recover" (w side)
    (when (:crashed w))
    (then (-> w (assoc-in (list :crashed) #f)
                (assoc-in (list :state) (replay-state w))
                (assoc-in (list :ts) (last-ts w))
                (assoc-in (list :height) (length (:wal w)))))))

(define tick-clock
  (rule "clock" (w side)
    (when (< (:clock w) 2))
    (then (update-in w (list :clock) (lambda (c) (+ c 1))))))

(define rules (list apply-input commit flush crash recover tick-clock))
(define (next w) (successors rules sides w))

;; ---- properties
(define (wal-outputs w) (map row-output (:wal w)))
(define (nondecreasing? xs) (or (null? xs) (null? (cdr xs)) (and (<= (car xs) (cadr xs)) (nondecreasing? (cdr xs)))))

(define invariants
  (list
   (property "outputs leave only after their WAL row is committed" (w)
     (every (lambda (o) (member o (wal-outputs w))) (:sent w)))
   (property "no peer input halts the Runtime: only local corruption does (R-X1)" (w)
     (or (not (:halted w)) (equal? (:halt-cause w) "fatal")))
   (property "recovery reproduces the committed state" (w)
     (or (:staged w) (:crashed w) (equal? (:state w) (:committed-state w))))
   (property "the frame timestamp never goes back" (w)
     (nondecreasing? (map row-ts (:wal w))))
   (property "the WAL is contiguous: heights are 1, 2, 3 ..." (w)
     (equal? (map row-height (:wal w)) (iota (length (:wal w)) 1)))
   (property "no input is lost: committed, staged, queued, or the halting one" (w)
     (every (lambda (i) (or (member (id i) (map row-input (:wal w)))
                            (and (:staged w) (equal? (id i) (row-input (:staged w))))
                            (member i (:queue w))
                            (and (:halted w) (equal? (kind i) "fatal"))))
            all-inputs))))

;; done: halted, or every input is committed and every output left
(define (finished? w)
  (and (not (:crashed w)) (not (:staged w))
       (or (:halted w) (null? (:queue w)))
       (null? (unsent w))))

(define runtime (dict :init init :next next :invariants invariants :at-rest (list) :goal finished?))
