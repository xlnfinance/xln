;; The J batch of one Entity against a chain that processes a batch atomically. A description of
;; what xln.ts does (pure/xln.ts 2294-3093, 18116-18345) and of the recovery it lacks.
;;
;; Chain (Depository.processBatch, contracts D:329-575): a batch carries the entity's nonce and
;; must be nonce + 1 exactly; it is ATOMIC: every op applies or none does, there is no per-op
;; failure, and a failure emits nothing but the revert. Success emits one event that names the
;; batch and, here, the ops it applied.
;;   r2c    moves one unit from the entity's reserve into collateral. Not idempotent.
;;   fin-a  finalizes a dispute on Account A. It reverts while A's HTLC deadline is open (H1).
;;
;; Entity (JBatch): a draft of ops, a phase (idle | inflight | quarantined) and the sent batch.
;;   queue      an Account produces an op. A full draft REFUSES it with notice (lessons R-J3).
;;   seal       idle and a draft: build a batch at chain nonce + 1. Dispute work goes ALONE and first
;;              (N2: a finalize whose HTLC deadline is open reverts the whole batch, so it is never
;;              bundled with other Accounts' ops).
;;   retry      resend the sent batch at its own nonce.
;;   abort      give up on the sent batch and requeue its ops (xln.ts `j_abort_sent_batch`).
;;   observe    the chain's event arrives. Per-op effects are the truth: the ops it names are DONE.
;;              exact pending (nonce, hash) -> idle. A different hash at a nonce >= pending ->
;;              quarantined (an aborted batch landed after a new one was sealed at its nonce).
;;              An older nonce only syncs.
;;   recover    a quarantined batch is requeued minus the ops already done. xln.ts has no automatic
;;              recovery (open question 3): only a manual abort or clear, and on a non-hub Entity nobody.
;;
;; Faults: the chain may drop a submitted batch or revert it for a reason outside the batch
;; (a reserve spent elsewhere), once (`faults`). Time ticks; A's deadline is 1.
;;
;; Not modelled: Hanko bytes, the J-prefix attestation round, gas and size limits (a batch size
;; cap stands for them), reorgs below finality (J_HISTORY_FINALIZED_REORG is a Runtime halt; policy
;; open, see QUESTIONS), several tokens, watchers. Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable draft-cap  (s/number) 2)
(define/overridable max-aborts (s/number) 1)
(define/overridable faults     (s/number) 0)
(define/overridable a-deadline (s/number) 1)
(define/overridable max-time   (s/number) 2)
(define/overridable ops (s/array (s/string)) (list "r1" "fin-a" "r2"))

(define sides (list :entity))
(define (op-list) (vector->list ops))
(define (finalize? op) (equal? op "fin-a"))

(define init
  (dict :now 0
        :unsent (op-list) :draft (list) :refused (list) :done (list)
        :phase :idle :sent #f :chain-nonce 0 :seals 0 :aborts 0 :halted #f
        :nonce 0 :reserve 3 :collateral 0 :applied (list) :processed (list)
        :inbox (list) :events (list) :reverts (list) :faults faults))

;; ---- the chain
(define (batch nonce hash ops) (dict :nonce nonce :hash hash :ops ops))

;; an op can apply now, given the reserve left after the earlier ops of the batch
(define (op-ok? w op reserve)
  (if (finalize? op) (> (:now w) a-deadline) (>= reserve 1)))
(define (batch-ok? w ops)
  (let loop ((rest ops) (reserve (:reserve w)))
    (cond ((null? rest) #t)
          ((not (op-ok? w (car rest) reserve)) #f)
          (else (loop (cdr rest) (if (finalize? (car rest)) reserve (- reserve 1)))))))
(define (apply-op w op)
  (if (finalize? op)
      (update-in w (list :applied) (lambda (a) (append a (list op))))
      (-> w (update-in (list :reserve) (lambda (r) (- r 1)))
            (update-in (list :collateral) (lambda (c) (+ c 1)))
            (update-in (list :applied) (lambda (a) (append a (list op)))))))

;; the whole batch applies, the nonce advances, one event names what was applied
(define (succeed w b)
  (-> (reduce (lambda (op acc) (apply-op acc op)) w (:ops b))
      (assoc-in (list :nonce) (:nonce b))
      (update-in (list :processed) (lambda (p) (append p (:ops b))))
      (update-in (list :events) (lambda (e) (append e (list (dict :nonce (:nonce b) :hash (:hash b) :ops (:ops b))))))))
;; nothing applies; the revert is recorded for the properties, the entity is told nothing
(define (revert w b)
  (update-in w (list :reverts)
             (lambda (r) (let ((rec (dict :ops (:ops b) :now (:now w)))) (if (member rec r) r (append r (list rec)))))))

(define (process-batch w b fault?)
  (cond ((not (= (:nonce b) (+ (:nonce w) 1))) w)
        (fault? (revert w b))
        ((batch-ok? w (:ops b)) (succeed w b))
        (else (revert w b))))

(define (remove-nth lst i) (append (take lst i) (list-tail lst (+ i 1))))
(define (process-nth i fault?)
  (rule (str (if fault? "fault-revert " "process ") i) (w side)
    (when (and (< i (length (:inbox w))) (or (not fault?) (> (:faults w) 0))))
    (then (let* ((b (list-ref (:inbox w) i))
                 (w1 (update-in w (list :inbox) (lambda (q) (remove-nth q i)))))
            (process-batch (if fault? (update-in w1 (list :faults) (lambda (f) (- f 1))) w1) b fault?)))))
(define (drop-nth i)
  (rule (str "drop " i) (w side)
    (when (and (< i (length (:inbox w))) (> (:faults w) 0)))
    (then (-> w (update-in (list :inbox) (lambda (q) (remove-nth q i)))
                (update-in (list :faults) (lambda (f) (- f 1)))))))

;; ---- the entity
(define (submit w b)
  (update-in w (list :inbox) (lambda (q) (if (member b q) q (append q (list b))))))

(define queue
  (rule "queue" (w side)
    (when (pair? (:unsent w)))
    (then (let ((op (car (:unsent w))) (w1 (update-in w (list :unsent) cdr)))
            (if (< (length (:draft w1)) draft-cap)
                (update-in w1 (list :draft) (lambda (d) (append d (list op))))
                (full-draft w1 op))))))
;; R-J3: a full draft is a refusal with notice
(define (full-draft w op) (update-in w (list :refused) (lambda (r) (append r (list op)))))

(define (pick-ops draft)
  (let ((fin (find finalize? draft)))
    (if fin (list fin) draft)))

(define seal
  (rule "seal" (w side)
    (when (and (equal? (:phase w) :idle) (pair? (:draft w))))
    (then (let* ((ops (pick-ops (:draft w)))
                 (b (batch (+ (:chain-nonce w) 1) (str "h" (+ (:seals w) 1)) ops)))
            (-> (submit w b)
                (assoc-in (list :phase) :inflight)
                (assoc-in (list :sent) b)
                (update-in (list :seals) (lambda (n) (+ n 1)))
                (update-in (list :draft) (lambda (d) (filter (lambda (op) (not (member op ops))) d))))))))

(define retry
  (rule "retry" (w side)
    (when (equal? (:phase w) :inflight))
    (then (submit w (:sent w)))))

(define (not-done w ops) (filter (lambda (op) (not (member op (:done w)))) ops))
(define (requeue w)
  (-> w (update-in (list :draft) (lambda (d) (append (not-done w (:ops (:sent w))) d)))
        (assoc-in (list :sent) #f)
        (assoc-in (list :phase) :idle)))

(define abort
  (rule "abort" (w side)
    (when (and (equal? (:phase w) :inflight) (< (:aborts w) max-aborts)))
    (then (update-in (requeue w) (list :aborts) (lambda (n) (+ n 1))))))

(define recover
  (rule "recover" (w side)
    (when (equal? (:phase w) :quarantined))
    (then (requeue w))))

(define (observe-event w e)
  (let* ((w1 (-> w (update-in (list :chain-nonce) (lambda (n) (max n (:nonce e))))
                   (update-in (list :done) (lambda (d) (append d (filter (lambda (op) (not (member op d))) (:ops e)))))
                   ;; an op the chain applied is not drafted again, whatever batch requeued it
                   (update-in (list :draft) (lambda (d) (filter (lambda (op) (not (member op (:ops e)))) d)))))
         (sent (:sent w)))
    (cond ((not (equal? (:phase w) :inflight)) w1)
          ((and (= (:nonce e) (:nonce sent)) (equal? (:hash e) (:hash sent)))
           (-> w1 (assoc-in (list :phase) :idle) (assoc-in (list :sent) #f)))
          ((>= (:nonce e) (:nonce sent)) (assoc-in w1 (list :phase) :quarantined))
          (else w1))))

(define observe
  (rule "observe" (w side)
    (when (pair? (:events w)))
    (then (observe-event (update-in w (list :events) cdr) (car (:events w))))))

(define tick
  (rule "tick" (w side)
    (when (< (:now w) max-time))
    (then (update-in w (list :now) (lambda (n) (+ n 1))))))

(define (rules-for w)
  (let ((is (iota (length (:inbox w)))))
    (append (list queue seal retry abort recover observe tick)
            (map (lambda (i) (process-nth i #f)) is)
            (map (lambda (i) (process-nth i #t)) is)
            (map drop-nth is))))
(define (next w) (successors (rules-for w) sides w))

;; ---- properties
(define (in-batch w) (if (:sent w) (:ops (:sent w)) (list)))
(define invariants
  (list
   (property "the chain is atomic: every applied op came from a batch that succeeded" (w)
     (every (lambda (op) (member op (:processed w))) (:applied w)))
   (property "no op is applied twice on chain" (w)
     (= (length (:applied w)) (length (delete-duplicates (:applied w)))))
   (property "a full batch is a refusal, never a halt" (w) (not (:halted w)))
   (property "no submitted op is lost: unsent, drafted, in the sent batch, applied, or refused with notice" (w)
     (every (lambda (op)
              (or (member op (:unsent w)) (member op (:draft w)) (member op (in-batch w))
                  (member op (:applied w)) (member op (:refused w))))
            (op-list)))
   (property "a deadline revert never blocks another Account's ops: a reverted finalize goes alone" (w)
     (every (lambda (r) (or (not (member "fin-a" (:ops r))) (= (length (:ops r)) 1))) (:reverts w)))
   (property "collateral is exactly what the applied r2c ops moved" (w)
     (= (:collateral w) (length (filter (lambda (op) (not (finalize? op))) (:applied w)))))))

;; done: every op is applied or refused, the entity has nothing in flight and knows it
(define (finished? w)
  (and (null? (:unsent w)) (null? (:draft w)) (equal? (:phase w) :idle)
       (every (lambda (op) (or (member op (:applied w)) (member op (:refused w)))) (op-list))
       (every (lambda (op) (member op (:done w))) (:applied w))))

(define j-batch (dict :init init :next next :invariants invariants :at-rest (list) :goal finished?))
