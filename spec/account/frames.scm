;; Bilateral Account frames — a description, not an implementation.
;;
;; Two replicas, :left and :right, and one FIFO link into each. A replica holds
;; its committed history (newest frame first), a mempool, and at most one pending
;; frame. The frame hash is abstracted as the history itself: equal heads mean
;; equal hashes. When both propose at once, left keeps its frame; right rolls its
;; own back into the mempool, commits left's, and acks.
;;
;; Abstractions (what this page does NOT cover):
;;   - a receiver commits a frame when it arrives; xln.ts holds it as a `received`
;;     candidate first;
;;   - a frame and its ack are separate messages (xln.ts can ride an ack on the next frame);
;;   - links are reliable and FIFO: no loss, no resend;
;;   - every tx is valid: no frame is rejected on content.
;;
;; Needs lib/vocabulary.scm (rule, property) and lib/check.scm (successors).

;; ---- model bounds: declared, typed inputs of this page
(define/overridable left-txs  (s/array (s/string)) (list "a" "b"))
(define/overridable right-txs (s/array (s/string)) (list "x" "y"))

;; ---- the world
(define sides (list :left :right))
(define (peer side) (if (equal? side :left) :right :left))
(define (txs-of side) (vector->list (if (equal? side :left) left-txs right-txs)))
(define (replica) (dict :head (list) :mempool (list) :pending #f))
(define init
  (dict :left   (replica)
        :right  (replica)
        :inbox  (dict :left (list) :right (list))
        :unsent (dict :left (txs-of :left) :right (txs-of :right))
        :fault  #f))

;; ---- frames and messages
(define (frame-hash f) (cons (:txs f) (:prev f)))
(define (frame-msg f) (dict :kind :frame :frame f))
(define (ack-msg h) (dict :kind :ack :hash h))
(define (fault why) (dict :kind :fault :why why))

;; ---- one replica receiving one message → (dict :replica :sent)
(define (commit r head) (-> r (assoc-in (list :head) head) (assoc-in (list :pending) #f)))
(define (roll-back r)
  (-> r (update-in (list :mempool) (lambda (m) (append (:txs (:pending r)) m)))
        (assoc-in (list :pending) #f)))

(define (on-frame side r f)
  (cond
    ((not (equal? (:prev f) (:head r)))     (dict :replica r :sent (list (fault "frame does not extend head"))))
    ((and (:pending r) (equal? side :left)) (dict :replica r :sent (list)))
    (else (dict :replica (commit (if (:pending r) (roll-back r) r) (frame-hash f))
                :sent    (list (ack-msg (frame-hash f)))))))

(define (on-ack r h)
  (if (and (:pending r) (equal? (frame-hash (:pending r)) h))
      (dict :replica (commit r h) :sent (list))
      (dict :replica r :sent (list (fault "ack for no pending frame")))))

(define (receive side r m)
  (case (:kind m)
    ((:frame) (on-frame side r (:frame m)))
    ((:ack)   (on-ack r (:hash m)))))

;; ---- rules
(define (enqueue w side msgs) (update-in w (list :inbox side) (lambda (q) (append q msgs))))
(define (faults msgs) (filter (lambda (m) (equal? (:kind m) :fault)) msgs))

(define submit
  (rule "submit" (w side)
    (when (pair? (get-in w (list :unsent side))))
    (then (let ((tx (car (get-in w (list :unsent side)))))
            (-> w (update-in (list side :mempool) (lambda (m) (append m (list tx))))
                  (update-in (list :unsent side) cdr))))))

(define propose
  (rule "propose" (w side)
    (when (and (not (get-in w (list side :pending)))
               (pair? (get-in w (list side :mempool)))))
    (then (let ((f (dict :txs (get-in w (list side :mempool)) :prev (get-in w (list side :head)))))
            (-> w (assoc-in (list side :pending) f)
                  (assoc-in (list side :mempool) (list))
                  (enqueue (peer side) (list (frame-msg f))))))))

(define deliver
  (rule "deliver" (w side)
    (when (pair? (get-in w (list :inbox side))))
    (then (let* ((out (receive side (side w) (car (get-in w (list :inbox side)))))
                 (bad (faults (:sent out))))
            (-> w (assoc-in (list side) (:replica out))
                  (update-in (list :inbox side) cdr)
                  (enqueue (peer side) (remove (lambda (m) (member m bad)) (:sent out)))
                  (assoc-in (list :fault) (if (pair? bad) (:why (car bad)) #f)))))))

(define rules (list submit propose deliver))
(define (next w) (if (:fault w) (list) (successors rules sides w)))

;; ---- properties
(define (extends? long short)
  (and (>= (length long) (length short))
       (equal? (list-tail long (- (length long) (length short))) short)))
(define (committed r) (append-map (lambda (frame) frame) (:head r)))
(define (committed-in-order r) (append-map (lambda (frame) frame) (reverse (:head r))))
(define (held r) (append (committed r) (:mempool r) (if (:pending r) (:txs (:pending r)) (list))))
(define (submitted w side)
  (let ((all (txs-of side)))
    (take all (- (length all) (length (get-in w (list :unsent side)))))))
(define (head-of w side) (get-in w (list side :head)))

(define invariants
  (list
   (property "no fault" (w)
     (not (:fault w)))
   (property "committed histories agree: one extends the other" (w)
     (or (extends? (head-of w :left) (head-of w :right))
         (extends? (head-of w :right) (head-of w :left))))
   (property "heights differ by at most one" (w)
     (<= (abs (- (length (head-of w :left)) (length (head-of w :right)))) 1))
   (property "no submitted tx is lost" (w)
     (every (lambda (side) (every (lambda (tx) (member tx (held (side w)))) (submitted w side)))
            sides))
   (property "no tx committed twice" (w)
     (every (lambda (side)
              (let ((txs (committed (side w)))) (= (length txs) (length (delete-duplicates txs)))))
            sides))
   (property "each side's txs commit in submission order" (w)
     (every (lambda (side)
              (let ((mine (filter (lambda (tx) (member tx (txs-of side))) (committed-in-order (side w)))))
                (equal? mine (take (txs-of side) (length mine)))))
            sides))))

(define at-rest
  (list
   (property "at rest: both sides committed the same history with every tx" (w)
     (and (equal? (head-of w :left) (head-of w :right))
          (= (length (committed (:left w))) (+ (length (txs-of :left)) (length (txs-of :right))))))))

(define account-frames (dict :init init :next next :invariants invariants :at-rest at-rest))
