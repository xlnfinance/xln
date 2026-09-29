;; Entity consensus: three validators, quorum two, one leader per view. A description of what
;; xln.ts does (pure/xln.ts 27659-29140) and of the one rule it lacks (R-E3, lessons B-E1).
;;
;; The round, as xln.ts runs it:
;;   propose   the leader of the replica's view, phase open, folds its mempool into a frame for
;;             height + 1, signs it (its own precommit) and sends the proposal. Phase: proposed.
;;   lock      a validator that has not signed at this height and sees a proposal of its view or
;;             newer signs it too. Two signatures (leader + itself) are a quorum, so it commits
;;             at once and tells everyone (`commit`). A validator signs at most one frame per height.
;;   commit    a validator that receives a certified frame for its next height installs it and
;;             drops the txs it holds from its mempool.
;;   forward   a validator that is not the leader sends its retained txs to the leader.
;;   timeout   a validator moves to the next view. A `proposed` validator KEEPS its proposal
;;             (xln.ts 29137).
;;
;; The hard case (lessons B-E1): the leader of view 0 has proposed, the others moved to view 1, the
;; leader of view 1 proposes a different frame at the same height and it commits. A holds its own
;; uncommitted proposal and now sees a certified frame at that height.
;;   xln.ts: refusal `commit_conflict` (28705); the proposal stays, the replica is stranded.
;;   R-E3 (chosen here): the replica drops its proposal, installs the certified frame, and its
;;   txs, still in the mempool, ride in a later frame.
;;
;; Abstractions: messages are never lost or reordered beyond "delivered in any order"; the
;; view-change certificate is not modelled (a validator moves view by itself), which only adds
;; behaviours; the signature is the signer's name; hashes are the frame itself. One shared frame
;; per height, no J-prefix rounds (see j/batch.scm), no Hanko bytes.
;;
;; Needs lib/vocabulary.scm and lib/check.scm.

(define/overridable max-view   (s/number) 1)
(define/overridable max-height (s/number) 1)
(define/overridable a-txs (s/array (s/string)) (list "a"))
(define/overridable b-txs (s/array (s/string)) (list "b"))

(define replicas (list :a :b :c))
;; the one validator that loses patience with its leader. A view change needs a certificate of
;; timeout votes; here one validator moves alone, which is enough for two leaders to be live at
;; once (A in view 0, B in view 1), the case R-E3 is about.
(define impatient :b)
(define quorum 2)
(define (leader-of view) (list-ref replicas (modulo view 3)))
(define (others side) (filter (lambda (r) (not (equal? r side))) replicas))

;; a frame is (height tx tx ...)
(define (frame-height f) (car f))
(define (frame-txs f) (cdr f))
(define (replica txs)
  (dict :committed (list) :view 0 :mempool txs :phase :open :proposal #f :signed #f))
(define init
  (dict :a (replica (vector->list a-txs)) :b (replica (vector->list b-txs)) :c (replica (list))
        :net (list)))

(define (height r) (length (:committed r)))
(define (next-height r) (+ (height r) 1))
(define (committed-txs r) (append-map frame-txs (:committed r)))
(define (without-txs mempool txs) (filter (lambda (t) (not (member t txs))) mempool))

;; ---- messages: (dict :kind :prop | :commit | :fwd, :to, ...)
;; the network is a set: kept sorted by the message's canonical text, so equal sets are equal worlds
(define (insert-msg m net)
  (cond ((null? net) (list m))
        ((equal? m (car net)) net)
        ((string<? (canon m) (canon (car net))) (cons m net))
        (else (cons (car net) (insert-msg m (cdr net))))))
(define (send w msgs)
  (update-in w (list :net) (lambda (net) (reduce (lambda (m acc) (insert-msg m acc)) net msgs))))
(define (msgs-to side mk) (map (lambda (r) (mk r)) (others side)))

;; ---- what installing a certified frame does to a replica
(define (install r f)
  (-> r
      (update-in (list :committed) (lambda (cs) (append cs (list f))))
      (update-in (list :mempool) (lambda (m) (without-txs m (frame-txs f))))
      (assoc-in (list :phase) :open)
      (assoc-in (list :proposal) #f)
      (assoc-in (list :signed) #f)))

(define (certified-here? r f) (= (frame-height f) (next-height r)))

;; ---- rules
(define propose
  (rule "propose" (w side)
    (when (let ((r (side w)))
            (and (equal? (leader-of (:view r)) side) (equal? (:phase r) :open)
                 (pair? (:mempool r)) (< (height r) max-height))))
    (then (let* ((r (side w))
                 (f (cons (next-height r) (:mempool r))))
            (-> w (update-in (list side) (lambda (r) (-> r (assoc-in (list :phase) :proposed)
                                                          (assoc-in (list :proposal) f)
                                                          (assoc-in (list :signed) f))))
                  (send (msgs-to side (lambda (to) (dict :kind :prop :frame f :view (:view r) :to to)))))))))

(define timeout
  (rule "timeout" (w side)
    (when (and (equal? side impatient) (< (:view (side w)) max-view)))
    (then (update-in w (list side :view) (lambda (v) (+ v 1))))))

(define forward
  (rule "forward" (w side)
    (when (let ((r (side w)))
            (and (not (equal? (leader-of (:view r)) side)) (pair? (:mempool r)))))
    (then (let ((r (side w)))
            (send w (map (lambda (t) (dict :kind :fwd :tx t :to (leader-of (:view r)))) (:mempool r)))))))

;; a proposal from my view or a newer one, at my next height, when I have not signed at it
(define (on-prop w side m)
  (let ((r (side w)) (f (:frame m)))
    (if (and (>= (:view m) (:view r)) (certified-here? r f) (not (:signed r)))
        ;; sign; leader + me is a quorum, so commit and tell the others
        (-> w (assoc-in (list side) (install (assoc-in r (list :view) (:view m)) f))
              (send (msgs-to side (lambda (to) (dict :kind :commit :frame f :to to)))))
        w)))

;; a certified frame reaches me
(define (on-commit w side m)
  (let ((r (side w)) (f (:frame m)))
    (cond ((not (certified-here? r f)) w)
          ((and (:proposal r) (not (equal? (:proposal r) f))) (on-conflict w side f))
          (else (assoc-in w (list side) (install r f))))))

;; R-E3: drop my own proposal, adopt the certified frame; my txs are still in my mempool
(define (on-conflict w side f)
  (assoc-in w (list side) (install (side w) f)))

(define (on-fwd w side m)
  (let ((r (side w)) (t (:tx m)))
    (if (or (member t (:mempool r)) (member t (committed-txs r)))
        w
        (update-in w (list side :mempool) (lambda (mp) (append mp (list t)))))))

(define (deliver-nth i)
  (rule (str "deliver " i) (w side)
    (when (and (< i (length (:net w))) (equal? (:to (list-ref (:net w) i)) side)))
    (then (let* ((m (list-ref (:net w) i))
                 (w1 (update-in w (list :net) (lambda (net) (append (take net i) (list-tail net (+ i 1)))))))
            (case (:kind m)
              ((:prop)   (on-prop w1 side m))
              ((:commit) (on-commit w1 side m))
              ((:fwd)    (on-fwd w1 side m)))))))

(define (rules-for w)
  (append (list propose timeout forward) (map deliver-nth (iota (length (:net w))))))
(define (next w) (successors (rules-for w) replicas w))

;; ---- properties
(define (prefix? short long)
  (and (<= (length short) (length long)) (equal? short (take long (length short)))))
(define all-txs (append (vector->list a-txs) (vector->list b-txs)))

(define invariants
  (list
   (property "agreement: no two validators commit different frames at a height" (w)
     (every (lambda (x) (every (lambda (y) (or (prefix? (:committed (x w)) (:committed (y w)))
                                                (prefix? (:committed (y w)) (:committed (x w)))))
                               replicas))
            replicas))
   (property "no tx is committed twice" (w)
     (every (lambda (r) (let ((ts (committed-txs (r w)))) (= (length ts) (length (delete-duplicates ts)))))
            replicas))
   (property "only submitted txs are committed" (w)
     (every (lambda (r) (every (lambda (t) (member t all-txs)) (committed-txs (r w)))) replicas))
   ;; a tx is committed, or still held: in a mempool, a proposal, or on its way to a leader
   (property "no submitted tx is lost" (w)
     (every (lambda (t)
              (or (some (lambda (r) (member t (committed-txs (r w)))) replicas)
                  (some (lambda (r) (member t (:mempool (r w)))) replicas)
                  (some (lambda (r) (and (:proposal (r w)) (member t (frame-txs (:proposal (r w)))))) replicas)
                  (some (lambda (m) (and (equal? (:kind m) :fwd) (equal? (:tx m) t))) (:net w))))
            all-txs))
   (property "a validator signs one frame per height" (w)
     (every (lambda (r) (or (not (:proposal (r w))) (equal? (:proposal (r w)) (:signed (r w))))) replicas))))

;; done: nothing is left to propose and every validator has committed the same history
(define (done? w)
  (and (every (lambda (r) (equal? (:committed (r w)) (:committed (:a w)))) replicas)
       (>= (height (:a w)) max-height)))

(define entity-consensus
  (dict :init init :next next :invariants invariants :at-rest (list) :goal done?))
