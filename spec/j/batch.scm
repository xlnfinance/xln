;; The J batch of one Entity against a chain that processes a batch atomically. A description of
;; what xln.ts does (pure/xln.ts 2294-3093, 18116-18345) and of the nonce rule it lacks.
;;
;; Chain (Depository.processBatch, contracts D:329-575): a batch carries the entity's nonce and
;; must be nonce + 1 exactly; it is ATOMIC: every op applies or none does, there is no per-op
;; failure, and a failure emits nothing but the revert. Success emits one event that names the
;; batch and, here, the ops it applied.
;;   r2c    moves one unit from the entity's reserve into collateral. Not idempotent.
;;   x1     a deposit leg (externalTokenToReserve): pulls a token from outside into the reserve. Not idempotent.
;;   start-a a dispute START on Account A. It carries the account's ondeltaEpoch (0) and is SKIPPED on a mismatch
;;          (coordinator, 01:16): a start signed for an old epoch can never hold again.
;;   stl-a  a settlement (or C2R) on Account A that carries the counterparty's signature over the account
;;          epoch it was signed at (0). It applies while A is still at epoch 0 and moves A to epoch 1.
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
;; A FAILED PAYMENT BATCH TAKES ITS NONCE (coordinator R-J5, 20:29; refined 22:31) AND BATCHES ARE SPLIT (R-SPLIT).
;; Two classes. HARD ops: dispute ops (finalize, counter, reveal, hash ladder) and DEPOSIT LEGS
;; (externalTokenToReserve). A batch carrying any hard op that fails reverts whole and takes NO nonce: the
;; deadline wait (H1) is the dispute case, and a deposit leg never soft-fails, so a relayer cannot burn
;; the Entity's nonce with a batch whose token pull it made fail. SOFT ops: payment, settlement, reserve.
;; A batch of soft ops that fails applies none of them, still consumes its entity nonce and emits
;; BatchFailed(entity, nonce, reason, bad ops); the Entity reads it as a J fact and re-queues the batch's
;; work at a fresh nonce. A BAD COUNTERPARTY SIGNATURE inside a batch is such a soft fail (a settlement
;; or C2R signed at an old account epoch): the ops named bad are RETURNED to their Account with notice (a
;; new signature is that Account's business, not a resend), the others go back to the draft. Only a failure
;; of the batch's own hanko authorisation reverts without taking the nonce (not modelled: the Entity signs
;; every batch it sends). So hard ops never share a batch with soft ops (R-SPLIT): a mixed batch would
;; revert without its nonce and stall every batch above it. Why the nonce matters: a signed batch is
;; final at its nonce, so a batch that reverted without taking it would block every urgent batch above it.
;;
;; R-J2 EXTENDED (coordinator, 23:42): any dispute op whose precondition can never hold again is skipped with
;; DisputeOpSkipped, never a revert. Besides an op already applied and a counter after the finalize, that is a
;; finalize after a counter landed (the finalize was prepared for the initial proof; the counter path needs another).
;; The batch lands and takes its nonce. A transient failure (the H1 deadline wait) still reverts whole.
;;
;; R-COSIGN (coordinator, 23:42): a batch that carries a co-signed op (a settlement or a C2R, `stl-a`) carries only
;; ops for that one Account. A counterparty's state change or a relayer's gas choice can fail such a batch, so
;; nothing unrelated rides with it (bug `cosign-bundle`).
;;
;; J6 (coordinator, 00:49): a deposit leg travels alone in its batch, and the Runtime signs a deposit batch only
;; after simulating it successfully. A token paused between the simulation and the landing makes the batch revert
;; (a plain revert, no nonce) and stalls the entity's nonce; that residual risk is ACCEPTED, not modelled away: the
;; page's fault on a deposit batch is exactly that case, and the batch is retried at its nonce (bug `legs-bundled`).
;;
;; GAS BUDGET (coordinator, 23:42, replaced 01:16): the fixed ERC-1271 stipend and its floor are gone. Each batch
;; carries a SIGNED GAS BUDGET the signer sets from its own simulation. If the relayer supplies less than the budget the
;; tx reverts and takes no nonce, whatever ops it carries (`gas-starves` times; bug `gas-soft` turns it into a
;; BatchFailed). Once the budget is given, a failure of a soft batch is BatchFailed with the nonce spent (R-J5);
;; whether a hard batch (dispute ops, deposit legs) also becomes BatchFailed once its budget is given is asked in Q-J-11.
;;
;; RUNTIME RULES (coordinator, 01:16): sign a batch only after simulating it successfully at the head; never sign a
;; time-gated op (a finalize before its H1 gate opens) before its gate opens; split any batch above the chain's tx gas
;; cap (here `draft-cap` stands for the cap). `simulate-first` 1 makes `seal` simulate the batch it is about to sign
;; (bug `signs-before-gate`).
;;
;; Faults: the chain may fail a batch that has no dispute op for a reason outside the batch (a reserve spent
;; elsewhere, a token pull refused), `faults` times, and drop a submitted batch, `drops` times. The
;; counterparty may move Account A to a new epoch elsewhere, `epoch-moves` times (a signature over epoch 0
;; is then bad). Time ticks; A's deadline is 1.
;;
;; Not modelled: Hanko bytes, the J-prefix attestation round, gas and size limits (a batch size
;; cap stands for them), reorgs below finality (J_HISTORY_FINALIZED_REORG is a Runtime halt; policy
;; open, see QUESTIONS), several tokens, watchers. Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable draft-cap  (s/number) 2)
(define/overridable max-aborts (s/number) 1)
(define/overridable faults     (s/number) 0)
(define/overridable drops      (s/number) 0)
;; the payee's secret may become public on chain (0: never, so H1 is the deadline alone; the
;; `public-secret` config sets 1)
(define/overridable secret-reveals (s/number) 0)
(define/overridable epoch-moves (s/number) 0)
(define/overridable gas-starves (s/number) 0)
;; 1: the Entity signs a batch only after it simulated successfully at the head (Runtime rule, 01:16)
(define/overridable simulate-first (s/number) 0)
(define/overridable a-deadline (s/number) 1)
(define/overridable max-time   (s/number) 2)
(define/overridable ops (s/array (s/string)) (list "r1" "fin-a" "cnt-a"))

(define sides (list :entity))
(define (op-list) (vector->list ops))
(define (finalize? op) (equal? op "fin-a"))
(define (start? op) (equal? op "start-a"))
(define (counter? op) (equal? op "cnt-a"))
(define (leg? op) (string-prefix? "x" op))
(define (settle? op) (equal? op "stl-a"))
(define (r2c? op) (equal? op "r1"))
;; the Account an op belongs to; `stl-a` is co-signed (R-COSIGN). A deposit leg belongs to none.
(define (cosigned? op) (settle? op))
(define (account-of op) (cond ((equal? op "r1") :b) ((leg? op) :none) (else :a)))

(define init
  (dict :now 0
        :unsent (op-list) :draft (list) :refused (list) :done (list)
        :phase :idle :sent #f :chain-nonce 0 :seals 0 :aborts 0 :halted #f
        :nonce 0 :reserve 3 :collateral 0 :applied (list) :skipped (list) :processed (list)
        :inbox (list) :events (list) :failures (list) :faults faults :drops drops
        :secret #f :finalized (list) :epoch 0 :moves 0 :returned (list) :gas gas-starves :starts (list)
        :signed-max 0 :signed (list) :abandoned (list)))

;; ---- the chain
(define (batch nonce hash ops) (dict :nonce nonce :hash hash :ops ops))

;; a dispute op is STALE once A's dispute is finalized, and a dispute op the chain already applied is
;; already applied: both are skipped (R-J2). A deposit (r2c) is not idempotent and never skipped.
(define (dispute-op? op) (or (finalize? op) (counter? op) (start? op)))
;; HARD ops revert the whole batch without its nonce when the batch fails (see the header)
(define (hard-op? op) (or (dispute-op? op) (leg? op)))
;; a settlement's counterparty signature holds while the account is still at the epoch it was signed at
(define (sig-ok? w op) (= (:epoch w) 0))
(define (stale-op? w op)
  (and (dispute-op? op)
       (or (member op (:applied w))
           (and (counter? op) (member "fin-a" (:applied w)))
           (and (finalize? op) (member "cnt-a" (:applied w)))
           (and (start? op) (not (= (:epoch w) 0))))))
;; H1: a finalize waits until Account A's payment deadline has passed, unless the secret is public. One
;; tick before the deadline and the deadline second itself both wait; one tick after does not; a public
;; secret ends the wait at any time (bugs `h1-at-deadline`, `h1-ignores-secret`).
(define (h1-wait-over? w) (or (:secret w) (> (:now w) a-deadline)))
;; an op can apply now, given the reserve left after the earlier ops of the batch; a stale op is
;; skipped, so it is always fine
(define (op-ok? w op reserve)
  (cond ((stale-op? w op) #t)
        ((finalize? op) (h1-wait-over? w))
        ((counter? op) #t)
        ((leg? op) #t)
        ((settle? op) (sig-ok? w op))
        (else (>= reserve 1))))
(define (batch-ok? w ops)
  (let loop ((rest ops) (reserve (:reserve w)) (applied (:applied w)))
    (cond ((null? rest) #t)
          ((not (op-ok? (assoc-in w (list :applied) applied) (car rest) reserve)) #f)
          (else (loop (cdr rest)
                      (cond ((and (r2c? (car rest)) (not (member (car rest) applied))) (- reserve 1))
                            ((leg? (car rest)) (+ reserve 1))
                            (else reserve))
                      (if (stale-op? (assoc-in w (list :applied) applied) (car rest)) applied (append applied (list (car rest)))))))))
(define (apply-op w op)
  (cond ((stale-op? w op) (update-in w (list :skipped) (lambda (s) (append s (list op)))))
        ((r2c? op)
         (-> w (update-in (list :reserve) (lambda (r) (- r 1)))
               (update-in (list :collateral) (lambda (c) (+ c 1)))
               (update-in (list :applied) (lambda (a) (append a (list op))))))
        ((leg? op)
         (-> w (update-in (list :reserve) (lambda (r) (+ r 1)))
               (update-in (list :applied) (lambda (a) (append a (list op))))))
        ((start? op)
         (-> w (update-in (list :starts) (lambda (l) (append l (list (:epoch w)))))
               (update-in (list :applied) (lambda (a) (append a (list op))))))
        ((settle? op)
         (-> w (update-in (list :epoch) (lambda (e) (+ e 1)))
               (update-in (list :applied) (lambda (a) (append a (list op))))))
        (else (update-in w (list :applied) (lambda (a) (append a (list op)))))))

;; why a dispute op is skipped: it was already applied, or it is stale (its dispute was finalized)
(define (skip-reason w op)
  (cond ((member op (:applied w)) "already-applied")
        ((and (start? op) (not (= (:epoch w) 0))) "epoch")
        (else "stale")))

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
        (update-in (list :finalized)
                   (lambda (f) (if (member "fin-a" (:applied landed))
                                   (append f (list (dict :now (:now w) :secret (:secret w))))
                                   f)))
        (update-in (list :events)
                   (lambda (e) (append e (list (dict :failed #f :nonce (:nonce b) :hash (:hash b)
                                                     :ops (:applied landed) :skips (:skips landed)))))))))
;; A failed batch applies nothing. With a hard op it is a plain revert (nonce untouched, nothing emitted; the
;; batch stays signed and is retried). Without one (R-J5) it takes its nonce and emits BatchFailed, naming the
;; settlements whose counterparty signature is bad. The failure is recorded for the properties. It is
;; `stale-only?` when the batch would have landed had its stale ops been left out (R-J2).
(define (has-dispute? ops) (some dispute-op? ops))
(define (bad-sig-ops w ops) (filter (lambda (op) (and (settle? op) (not (sig-ok? w op)))) ops))
;; the decision the chain takes on a failed batch: revert whole and keep the nonce, or take it (bug
;; `bad-sig-hard` reverts on a bad signature too)
(define (fail-hard? w ops bad) (some hard-op? ops))
(define (gas-hard? w b) #t)   ; bug `gas-soft`: a gas revert takes the nonce like a soft failure
(define (fail-batch w b fault?) (fail-with w b fault? #f))
(define (fail-with w b fault? gas?)
  (let* ((bad (bad-sig-ops w (:ops b)))
         (hard (or (and gas? (gas-hard? w b)) (fail-hard? w (:ops b) bad)))
         (rec (dict :ops (:ops b) :now (:now w) :nonce (:nonce b) :took? (not hard) :bad bad :secret (:secret w) :gas gas?
                    :stale-only? (and (not fault?) (some (lambda (op) (stale-op? w op)) (:ops b))
                                      (batch-ok? w (filter (lambda (op) (not (stale-op? w op))) (:ops b)))))))
    (let ((w1 (update-in w (list :failures) (lambda (r) (if (member rec r) r (append r (list rec)))))))
      (if hard
          w1
          (-> w1 (assoc-in (list :nonce) (:nonce b))
                 (update-in (list :events)
                            (lambda (e) (append e (list (dict :failed #t :nonce (:nonce b) :hash (:hash b) :bad bad
                                                              :reason (if (pair? bad) "signature" "reserve")))))))))))

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
(define (gas-nth i)
  (rule (str "gas-revert " i) (w side)
    (when (and (< i (length (:inbox w))) (> (:gas w) 0)
               (= (:nonce (list-ref (:inbox w) i)) (+ (:nonce w) 1))))
    (then (let* ((b (list-ref (:inbox w) i))
                 (w1 (update-in w (list :inbox) (lambda (q) (remove-nth q i)))))
            (fail-with (update-in w1 (list :gas) (lambda (g) (- g 1))) b #t #t)))))
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

;; J6: a deposit leg travels alone in its batch (coordinator, 00:49).
;; N2: a finalize goes alone. R-SPLIT: hard ops (dispute ops, deposit legs) never share a batch with soft ones.
;; R-COSIGN: a co-signed op goes with ops of its own Account only.
(define (pick-ops draft)
  (let ((fin (find finalize? draft)) (disputes (filter dispute-op? draft)) (legs (filter leg? draft))
        (cosigned (find cosigned? draft)))
    (cond (fin (list fin))
          ((pair? disputes) disputes)
          ((pair? legs) (list (car legs)))
          (cosigned (filter (lambda (op) (equal? (account-of op) (account-of cosigned))) draft))
          (else draft))))

;; F1: a fresh nonce is above every nonce the Entity ever signed (bug `resign-at-nonce`: chain + 1)
(define (fresh-nonce w) (+ (:signed-max w) 1))

(define (simulated-ok? w ops) (or (= simulate-first 0) (batch-ok? w ops)))
(define seal
  (rule "seal" (w side)
    (when (and (equal? (:phase w) :idle) (pair? (:draft w)) (simulated-ok? w (pick-ops (:draft w)))))
    (then (let* ((ops (pick-ops (:draft w)))
                 (b (batch (fresh-nonce w) (str "h" (+ (:seals w) 1)) ops)))
            (-> (submit w b)
                (assoc-in (list :phase) :inflight)
                (assoc-in (list :sent) b)
                (assoc-in (list :signed-max) (max (:signed-max w) (:nonce b)))
                (update-in (list :signed) (lambda (s) (append s (list (list (:nonce b) (:hash b) (:ops b) (:now w) (:secret w))))))
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
;; to the draft (deposits included) unless they are done, already drafted or in the sent batch. A settlement
;; with a bad counterparty signature is RETURNED to its Account instead: resending it would fail again.
(define (same-batch? b e) (and (= (:nonce b) (:nonce e)) (equal? (:hash b) (:hash e))))
(define (missing w ops)
  (filter (lambda (op) (not (or (member op (:done w)) (member op (:draft w)) (member op (in-batch w))))) ops))
(define (observe-failure w e)
  (let* ((w1 (update-in w (list :chain-nonce) (lambda (n) (max n (:nonce e)))))
         (was-sent (and (:sent w1) (same-batch? (:sent w1) e)))
         (dead (append (if was-sent (list (:sent w1)) (list)) (filter (lambda (b) (same-batch? b e)) (:abandoned w1))))
         (dead-ops (append-map (lambda (b) (:ops b)) dead))
         (w2 (-> (if was-sent (-> w1 (assoc-in (list :phase) :idle) (assoc-in (list :sent) #f)) w1)
                 (update-in (list :abandoned) (lambda (a) (filter (lambda (b) (not (same-batch? b e))) a)))))
         (sendable (filter (lambda (op) (not (member op (:bad e)))) dead-ops)))
    (-> w2 (update-in (list :draft) (lambda (d) (append (missing w2 sendable) d)))
           (update-in (list :returned)
                      (lambda (r) (append r (filter (lambda (op) (and (member op dead-ops) (not (member op r)))) (:bad e))))))))

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

;; the payee's secret becomes public on chain, once (a reveal op in a batch of its own)
(define reveal-secret
  (rule "secret revealed" (w side)
    (when (and (> secret-reveals 0) (not (:secret w))))
    (then (assoc-in w (list :secret) #t))))
;; the counterparty settles Account A elsewhere: A moves to a new epoch, and a signature over the old one is bad
(define epoch-move
  (rule "epoch moves" (w side)
    (when (< (:moves w) epoch-moves))
    (then (-> w (update-in (list :epoch) (lambda (e) (+ e 1)))
                (update-in (list :moves) (lambda (m) (+ m 1)))))))
(define tick
  (rule "tick" (w side)
    (when (< (:now w) max-time))
    (then (update-in w (list :now) (lambda (n) (+ n 1))))))

(define (rules-for w)
  (let ((is (iota (length (:inbox w)))))
    (append (list queue seal retry abort observe tick reveal-secret epoch-move)
            (map push-nth (iota (length (:abandoned w))))
            (map (lambda (i) (process-nth i #f)) is)
            (map (lambda (i) (process-nth i #t)) is)
            (map gas-nth is)
            (map drop-nth is))))
(define (next w) (successors (rules-for w) sides w))

;; ---- properties
(define (abandoned-ops w) (append-map (lambda (b) (:ops b)) (:abandoned w)))
(define (position x lst)
  (let loop ((rest lst) (i 0))
    (cond ((null? rest) -1) ((equal? (car rest) x) i) (else (loop (cdr rest) (+ i 1))))))
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
   (property "a failed batch of payment, settlement and reserve ops takes its nonce: the chain has moved past it (R-J5)" (w)
     (every (lambda (r) (or (:gas r) (some (lambda (op) (or (dispute-op? op) (leg? op))) (:ops r))
                            (and (:took? r) (<= (:nonce r) (:nonce w)))))
            (:failures w)))
   ;; R-J2 extended, restated from the rule and not through `stale-op?` (a planted bug redefines that one)
   (property "a finalize prepared for the initial proof never applies after a counter landed (R-J2 extended)" (w)
     (let ((a (:applied w)))
       (not (and (member "cnt-a" a) (member "fin-a" a) (< (position "cnt-a" a) (position "fin-a" a))))))
   ;; a dispute start carries the account's ondeltaEpoch (01:16); restated from the rule, not through `stale-op?`
   (property "a dispute start lands only at the account epoch it was signed for; on a mismatch it is skipped (01:16)" (w)
     (every (lambda (e) (= e 0)) (:starts w)))
   (property "a finalize is signed only after its gate opened when the Entity simulates first (Runtime rule, 01:16)" (w)
     (or (= simulate-first 0)
         (every (lambda (s) (or (not (member "fin-a" (list-ref s 2))) (list-ref s 4) (> (list-ref s 3) a-deadline))) (:signed w))))
   (property "gas below the signed budget is a plain revert: no nonce, no BatchFailed, whatever the batch carries" (w)
     (every (lambda (r) (or (not (:gas r)) (not (:took? r)))) (:failures w)))
   (property "a deposit leg travels alone in its batch (J6)" (w)
     (every (lambda (s) (or (not (some (lambda (op) (string-prefix? "x" op)) (list-ref s 2))) (= (length (list-ref s 2)) 1)))
            (:signed w)))
   (property "a batch with a co-signed op carries ops of that one Account only (R-COSIGN)" (w)
     (every (lambda (s)
              (let ((ops (list-ref s 2)))
                (every (lambda (op)
                         (or (not (settle? op))
                             (every (lambda (o) (equal? (account-of o) (account-of op))) ops)))
                       ops)))
            (:signed w)))
   (property "a failed batch with a deposit leg or a dispute op reverts whole and takes no nonce (R-J5 refined)" (w)
     (every (lambda (r) (or (not (some (lambda (op) (or (dispute-op? op) (leg? op))) (:ops r))) (not (:took? r))))
            (:failures w)))
   (property "deposit legs and dispute ops never share a batch with payment or settlement ops (R-SPLIT)" (w)
     (every (lambda (s)
              (let ((hard (lambda (op) (or (dispute-op? op) (leg? op)))) (ops (list-ref s 2)))
                (or (not (some hard ops)) (every hard ops))))
            (:signed w)))
   (property "a finalize lands only after the deadline or with the secret public (H1)" (w)
     (every (lambda (f) (or (:secret f) (> (:now f) a-deadline))) (:finalized w)))
   (property "a finalize reverts only while the deadline is open and the secret is not public (H1)" (w)
     (every (lambda (r) (or (:gas r) (not (member "fin-a" (:ops r))) (and (not (:secret r)) (<= (:now r) a-deadline)))) (:failures w)))
   (property "no op is applied twice on chain" (w)
     (= (length (:applied w)) (length (delete-duplicates (:applied w)))))
   (property "a full batch is a refusal, never a halt" (w) (not (:halted w)))
   (property "no submitted op is lost: unsent, drafted, in the sent batch, applied, or refused with notice" (w)
     (every (lambda (op)
              (or (member op (:unsent w)) (member op (:draft w)) (member op (in-batch w)) (member op (abandoned-ops w))
                  (member op (:applied w)) (member op (:skipped w)) (member op (:refused w)) (member op (:returned w))))
            (op-list)))
   (property "a deadline revert never blocks another Account's ops: a reverted finalize goes alone" (w)
     (every (lambda (r) (or (not (member "fin-a" (:ops r))) (= (length (:ops r)) 1))) (:failures w)))
   (property "collateral is exactly what the applied r2c ops moved" (w)
     (= (:collateral w) (length (filter r2c? (:applied w)))))))

;; done: every op is applied, skipped or refused, the entity has nothing in flight and knows it
(define (finished? w)
  (and (null? (:unsent w)) (null? (:draft w)) (equal? (:phase w) :idle)
       (every (lambda (op) (or (member op (:applied w)) (member op (:skipped w)) (member op (:refused w)) (member op (:returned w)))) (op-list))
       (every (lambda (op) (member op (:done w))) (append (:applied w) (:skipped w)))))

(define j-batch (dict :init init :next next :invariants invariants :at-rest (list) :goal finished?))
