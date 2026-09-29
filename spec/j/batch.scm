;; The J batch of one Entity against a chain that processes a batch atomically. A description of
;; what xln.ts does (pure/xln.ts 2294-3093, 18116-18345) and of the nonce rule it lacks.
;;
;; Chain (Depository.processBatch, contracts D:329-575): a batch carries the entity's nonce and
;; must be nonce + 1 exactly; it is ATOMIC: every op applies or none does, there is no per-op
;; failure, and a failure emits nothing but the revert. Success emits one event that names the
;; batch and, here, the ops it applied.
;;   r2c    moves one unit from the entity's reserve into collateral. Not idempotent.
;;   fin-a  finalizes a dispute on Account A. It reverts while A's HTLC deadline is open (H1).
;;   cnt-a  a dispute op on Account A that stops being useful once A's dispute is finalized (a counter,
;;          a second start). R-J2 (coordinator, 18:57; the contracts will change to match): a dispute op
;;          that is STALE or already applied is SKIPPED with an event; it never reverts the batch, so the
;;          other ops of the batch (a secret reveal, a deposit) still land.
;;
;; A SIGNED BATCH IS FINAL AT ITS NONCE (coordinator R-NONCE, widened 20:14 after the J2 review). It
;; never expires and processBatch is permissionless, so anyone can land it later; with R-J2 an
;; abandoned batch whose ops are all stale lands as a no-op and still takes its entity nonce. So the
;; Entity never signs different content at a nonce it has already signed, and always sends a
;; replacement at a FRESH nonce (above every nonce it ever signed). The chain still needs nonce + 1,
;; so the replacement lands after the abandoned batch does; anyone, the Entity included, can push it.
;;
;; Entity (JBatch): a draft of ops, a phase (idle | inflight), the sent batch and the abandoned ones.
;;   queue      an Account produces an op. A full draft REFUSES it with notice (lessons R-J3).
;;   seal       idle and a draft: sign a batch at a fresh nonce. Dispute work goes ALONE and first
;;              (N2: a finalize whose HTLC deadline is open reverts the whole batch, so it is never
;;              bundled with other Accounts' ops).
;;   retry      resend the sent batch at its own nonce.
;;   abort      give up waiting for the sent batch (xln.ts `j_abort_sent_batch`). The batch stays
;;              signed and may still land: it becomes ABANDONED. Only its dispute ops are requeued
;;              (a dispute op is idempotent under R-J2: if the abandoned batch lands first, the copy
;;              is skipped). A deposit is not idempotent and stays with the abandoned batch; requeueing
;;              it would apply it twice.
;;   push       land an abandoned batch (anyone can): the chain then accepts the next nonce.
;;   observe    the chain's event arrives. Per-op effects are the truth: the ops it names are DONE.
;;              The event of the sent batch -> idle. An older nonce only syncs. With fresh nonces a
;;              different hash at one nonce cannot happen, so the quarantine and its recovery that xln.ts
;;              lacked (open question 3) are gone.
;;
;; A FAILED PAYMENT BATCH TAKES ITS NONCE (coordinator R-J5, 20:29) AND BATCHES ARE SPLIT (R-SPLIT, 21:01).
;; A batch with NO dispute ops whose payment, settlement or reserve ops fail applies none of them, still
;; consumes its entity nonce and emits BatchFailed(entity, nonce, reason); the Entity reads it as a J fact
;; and re-queues the batch's work at a fresh nonce. Bad authentication still reverts and takes no nonce
;; (not modelled: the Entity signs every batch it sends). A batch WITH dispute ops (finalize, counter,
;; reveal, hash ladder) that fails reverts whole and takes NO nonce: the deadline wait (H1) is that case.
;; So dispute ops never share a batch with payment, settlement or reserve ops (R-SPLIT): a mixed batch
;; would revert without its nonce and stall every batch above it. Why the nonce matters: a signed batch is
;; final at its nonce, so a batch that reverted without taking it would block every urgent batch above it.
;;
;; Faults: the chain may fail a payment batch for a reason outside the batch (a reserve spent
;; elsewhere), `faults` times, and drop a submitted batch, `drops` times. Time ticks; A's deadline is 1.
;;
;; Not modelled: Hanko bytes, the J-prefix attestation round, gas and size limits (a batch size
;; cap stands for them), reorgs below finality (J_HISTORY_FINALIZED_REORG is a Runtime halt; policy
;; open, see QUESTIONS), several tokens, watchers. Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable draft-cap  (s/number) 2)
(define/overridable max-aborts (s/number) 1)
(define/overridable faults     (s/number) 0)
(define/overridable drops      (s/number) 0)
(define/overridable a-deadline (s/number) 1)
(define/overridable max-time   (s/number) 2)
(define/overridable ops (s/array (s/string)) (list "r1" "fin-a" "cnt-a"))

(define sides (list :entity))
(define (op-list) (vector->list ops))
(define (finalize? op) (equal? op "fin-a"))
(define (counter? op) (equal? op "cnt-a"))
(define (r2c? op) (not (or (finalize? op) (counter? op))))

(define init
  (dict :now 0
        :unsent (op-list) :draft (list) :refused (list) :done (list)
        :phase :idle :sent #f :chain-nonce 0 :seals 0 :aborts 0 :halted #f
        :nonce 0 :reserve 3 :collateral 0 :applied (list) :skipped (list) :processed (list)
        :inbox (list) :events (list) :failures (list) :faults faults :drops drops
        :signed-max 0 :signed (list) :abandoned (list)))

;; ---- the chain
(define (batch nonce hash ops) (dict :nonce nonce :hash hash :ops ops))

;; a dispute op is STALE once A's dispute is finalized, and a dispute op the chain already applied is
;; already applied: both are skipped (R-J2). A deposit (r2c) is not idempotent and never skipped.
(define (dispute-op? op) (or (finalize? op) (counter? op)))
(define (stale-op? w op)
  (and (dispute-op? op)
       (or (member op (:applied w))
           (and (counter? op) (member "fin-a" (:applied w))))))
;; an op can apply now, given the reserve left after the earlier ops of the batch; a stale op is
;; skipped, so it is always fine
(define (op-ok? w op reserve)
  (cond ((stale-op? w op) #t)
        ((finalize? op) (> (:now w) a-deadline))
        ((counter? op) #t)
        (else (>= reserve 1))))
(define (batch-ok? w ops)
  (let loop ((rest ops) (reserve (:reserve w)) (applied (:applied w)))
    (cond ((null? rest) #t)
          ((not (op-ok? (assoc-in w (list :applied) applied) (car rest) reserve)) #f)
          (else (loop (cdr rest)
                      (if (and (r2c? (car rest)) (not (member (car rest) applied))) (- reserve 1) reserve)
                      (if (stale-op? (assoc-in w (list :applied) applied) (car rest)) applied (append applied (list (car rest)))))))))
(define (apply-op w op)
  (cond ((stale-op? w op) (update-in w (list :skipped) (lambda (s) (append s (list op)))))
        ((r2c? op)
         (-> w (update-in (list :reserve) (lambda (r) (- r 1)))
               (update-in (list :collateral) (lambda (c) (+ c 1)))
               (update-in (list :applied) (lambda (a) (append a (list op))))))
        (else (update-in w (list :applied) (lambda (a) (append a (list op)))))))

;; why a dispute op is skipped: it was already applied, or it is stale (its dispute was finalized)
(define (skip-reason w op) (if (member op (:applied w)) "already-applied" "stale"))

;; the whole batch lands, the nonce advances. The event names the ops applied and, apart, each op
;; SKIPPED with its reason: the chain's DisputeOpSkipped(sender, counterentity, op, reason, nonce)
;; (coordinator R-J2 addition, 19:52). The Entity must read it as a J fact, or a node whose op was
;; skipped waits for the effect of an op that will never come.
(define (land w b)
  (let loop ((rest (:ops b)) (acc w) (applied (list)) (skips (list)))
    (cond ((null? rest) (dict :world acc :applied applied :skips skips))
          ((stale-op? acc (car rest))
           (loop (cdr rest) (apply-op acc (car rest)) applied
                 (append skips (list (list (car rest) (skip-reason acc (car rest)))))))
          (else (loop (cdr rest) (apply-op acc (car rest)) (append applied (list (car rest))) skips)))))
(define (succeed w b)
  (let ((landed (land w b)))
    (-> (:world landed)
        (assoc-in (list :nonce) (:nonce b))
        (update-in (list :processed) (lambda (p) (append p (:ops b))))
        (update-in (list :events)
                   (lambda (e) (append e (list (dict :failed #f :nonce (:nonce b) :hash (:hash b)
                                                     :ops (:applied landed) :skips (:skips landed)))))))))
;; A failed batch applies nothing. Without dispute ops (R-J5) it takes its nonce and emits BatchFailed;
;; with dispute ops it is a plain revert (nonce untouched, nothing emitted; the batch stays signed and
;; is retried). The failure is recorded for the properties. It is `stale-only?` when the batch would
;; have landed had its stale ops been left out (R-J2).
(define (has-dispute? ops) (some dispute-op? ops))
(define (fail-batch w b fault?)
  (let ((rec (dict :ops (:ops b) :now (:now w) :nonce (:nonce b) :dispute? (has-dispute? (:ops b))
                   :stale-only? (and (not fault?) (some (lambda (op) (stale-op? w op)) (:ops b))
                                     (batch-ok? w (filter (lambda (op) (not (stale-op? w op))) (:ops b)))))))
    (let ((w1 (update-in w (list :failures) (lambda (r) (if (member rec r) r (append r (list rec)))))))
      (if (has-dispute? (:ops b))
          w1
          (-> w1 (assoc-in (list :nonce) (:nonce b))
                 (update-in (list :events)
                            (lambda (e) (append e (list (dict :failed #t :nonce (:nonce b) :hash (:hash b) :reason "reserve"))))))))))

(define (process-batch w b fault?)
  (cond ((not (= (:nonce b) (+ (:nonce w) 1))) w)
        (fault? (fail-batch w b #t))
        ((batch-ok? w (:ops b)) (succeed w b))
        (else (fail-batch w b #f))))

(define (remove-nth lst i) (append (take lst i) (list-tail lst (+ i 1))))
(define (process-nth i fault?)
  (rule (str (if fault? "fault-revert " "process ") i) (w side)
    (when (and (< i (length (:inbox w)))
               (or (not fault?) (and (> (:faults w) 0) (not (has-dispute? (:ops (list-ref (:inbox w) i))))))))
    (then (let* ((b (list-ref (:inbox w) i))
                 (w1 (update-in w (list :inbox) (lambda (q) (remove-nth q i)))))
            (process-batch (if fault? (update-in w1 (list :faults) (lambda (f) (- f 1))) w1) b fault?)))))
(define (drop-nth i)
  (rule (str "drop " i) (w side)
    (when (and (< i (length (:inbox w))) (> (:drops w) 0)))
    (then (-> w (update-in (list :inbox) (lambda (q) (remove-nth q i)))
                (update-in (list :drops) (lambda (f) (- f 1)))))))

;; ---- the entity
(define (in-batch w) (if (:sent w) (:ops (:sent w)) (list)))
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

;; N2: a finalize goes alone. R-SPLIT: dispute ops never share a batch with payment ops.
(define (pick-ops draft)
  (let ((fin (find finalize? draft)) (disputes (filter dispute-op? draft)))
    (cond (fin (list fin))
          ((pair? disputes) disputes)
          (else draft))))

;; F1: a fresh nonce is above every nonce the Entity ever signed (bug `resign-at-nonce`: chain + 1)
(define (fresh-nonce w) (+ (:signed-max w) 1))

(define seal
  (rule "seal" (w side)
    (when (and (equal? (:phase w) :idle) (pair? (:draft w))))
    (then (let* ((ops (pick-ops (:draft w)))
                 (b (batch (fresh-nonce w) (str "h" (+ (:seals w) 1)) ops)))
            (-> (submit w b)
                (assoc-in (list :phase) :inflight)
                (assoc-in (list :sent) b)
                (assoc-in (list :signed-max) (max (:signed-max w) (:nonce b)))
                (update-in (list :signed) (lambda (s) (append s (list (list (:nonce b) (:hash b) (:ops b))))))
                (update-in (list :seals) (lambda (n) (+ n 1)))
                (update-in (list :draft) (lambda (d) (filter (lambda (op) (not (member op ops))) d))))))))

(define retry
  (rule "retry" (w side)
    (when (equal? (:phase w) :inflight))
    (then (submit w (:sent w)))))

(define (not-done w ops) (filter (lambda (op) (not (member op (:done w)))) ops))
;; what an abort puts back in the draft: dispute ops only (idempotent under R-J2). Bug
;; `requeue-deposit` puts back everything, so a deposit lands twice if the abandoned batch does.
(define (requeuable w ops) (filter dispute-op? (not-done w ops)))

(define abort
  (rule "abort" (w side)
    (when (and (equal? (:phase w) :inflight) (< (:aborts w) max-aborts)))
    (then (-> w (update-in (list :abandoned) (lambda (a) (append a (list (:sent w)))))
                (update-in (list :draft) (lambda (d) (append (requeuable w (:ops (:sent w))) d)))
                (assoc-in (list :sent) #f)
                (assoc-in (list :phase) :idle)
                (update-in (list :aborts) (lambda (n) (+ n 1)))))))

;; anyone can land an abandoned batch that the chain has not reached yet
(define (push-nth i)
  (rule (str "push " i) (w side)
    (when (and (< i (length (:abandoned w))) (> (:nonce (list-ref (:abandoned w) i)) (:nonce w))))
    (then (submit w (list-ref (:abandoned w) i)))))

;; the ops an event settles: applied, and skipped with a reason
(define (skip-ops e) (map car (:skips e)))
(define (event-ops e) (append (:ops e) (skip-ops e)))

;; R-J5: a batch failed. Nothing of it applied and its nonce is spent, so it can never land: its ops go back
;; to the draft (deposits included) unless they are done, already drafted or in the sent batch.
(define (same-batch? b e) (and (= (:nonce b) (:nonce e)) (equal? (:hash b) (:hash e))))
(define (missing w ops)
  (filter (lambda (op) (not (or (member op (:done w)) (member op (:draft w)) (member op (in-batch w))))) ops))
(define (observe-failure w e)
  (let* ((w1 (update-in w (list :chain-nonce) (lambda (n) (max n (:nonce e)))))
         (was-sent (and (:sent w1) (same-batch? (:sent w1) e)))
         (dead (append (if was-sent (list (:sent w1)) (list)) (filter (lambda (b) (same-batch? b e)) (:abandoned w1))))
         (w2 (-> (if was-sent (-> w1 (assoc-in (list :phase) :idle) (assoc-in (list :sent) #f)) w1)
                 (update-in (list :abandoned) (lambda (a) (filter (lambda (b) (not (same-batch? b e))) a))))))
    (update-in w2 (list :draft) (lambda (d) (append (missing w2 (append-map (lambda (b) (:ops b)) dead)) d)))))

(define (observe-event w e)
  (if (:failed e) (observe-failure w e) (observe-landing w e)))
(define (observe-landing w e)
  (let* ((w1 (-> w (update-in (list :chain-nonce) (lambda (n) (max n (:nonce e))))
                   (update-in (list :done) (lambda (d) (append d (filter (lambda (op) (not (member op d))) (event-ops e)))))
                   ;; an op the chain applied or skipped is not drafted again, whatever batch requeued it
                   (update-in (list :draft) (lambda (d) (filter (lambda (op) (not (member op (event-ops e)))) d)))))
         (sent (:sent w)))
    (cond ((not (equal? (:phase w) :inflight)) w1)
          ((and (= (:nonce e) (:nonce sent)) (equal? (:hash e) (:hash sent)))
           (-> w1 (assoc-in (list :phase) :idle) (assoc-in (list :sent) #f)))
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
    (append (list queue seal retry abort observe tick)
            (map push-nth (iota (length (:abandoned w))))
            (map (lambda (i) (process-nth i #f)) is)
            (map (lambda (i) (process-nth i #t)) is)
            (map drop-nth is))))
(define (next w) (successors (rules-for w) sides w))

;; ---- properties
(define (abandoned-ops w) (append-map (lambda (b) (:ops b)) (:abandoned w)))
(define invariants
  (list
   (property "the chain is atomic: every applied op came from a batch that succeeded" (w)
     (every (lambda (op) (member op (:processed w))) (:applied w)))
   (property "a stale or already applied dispute op is skipped, never a revert of the batch (R-J2)" (w)
     (every (lambda (r) (not (:stale-only? r))) (:failures w)))
   (property "only dispute ops are skipped: a deposit is never silently dropped" (w)
     (every dispute-op? (:skipped w)))
   (property "a signed batch is final at its nonce: no nonce is signed twice (R-NONCE, F1)" (w)
     (let ((ns (map car (:signed w)))) (= (length ns) (length (delete-duplicates ns)))))
   (property "a failed batch takes its nonce: the chain has moved past it (R-J5)" (w)
     (every (lambda (r) (or (:dispute? r) (<= (:nonce r) (:nonce w)))) (:failures w)))
   (property "dispute ops never share a batch with payment ops (R-SPLIT)" (w)
     (every (lambda (s) (or (not (has-dispute? (list-ref s 2))) (every dispute-op? (list-ref s 2)))) (:signed w)))
   (property "no op is applied twice on chain" (w)
     (= (length (:applied w)) (length (delete-duplicates (:applied w)))))
   (property "a full batch is a refusal, never a halt" (w) (not (:halted w)))
   (property "no submitted op is lost: unsent, drafted, in the sent batch, applied, or refused with notice" (w)
     (every (lambda (op)
              (or (member op (:unsent w)) (member op (:draft w)) (member op (in-batch w)) (member op (abandoned-ops w))
                  (member op (:applied w)) (member op (:skipped w)) (member op (:refused w))))
            (op-list)))
   (property "a deadline revert never blocks another Account's ops: a reverted finalize goes alone" (w)
     (every (lambda (r) (or (not (member "fin-a" (:ops r))) (= (length (:ops r)) 1))) (:failures w)))
   (property "collateral is exactly what the applied r2c ops moved" (w)
     (= (:collateral w) (length (filter r2c? (:applied w)))))))

;; done: every op is applied, skipped or refused, the entity has nothing in flight and knows it
(define (finished? w)
  (and (null? (:unsent w)) (null? (:draft w)) (equal? (:phase w) :idle)
       (every (lambda (op) (or (member op (:applied w)) (member op (:skipped w)) (member op (:refused w)))) (op-list))
       (every (lambda (op) (member op (:done w))) (append (:applied w) (:skipped w)))))

(define j-batch (dict :init init :next next :invariants invariants :at-rest (list) :goal finished?))
