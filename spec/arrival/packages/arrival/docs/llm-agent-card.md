# Arrival-Scheme

Sandboxed R7RS-small. Prefix s-exprs. No IO, no mutation.

```scheme
(dict :id 1 :status "open")
(:status row)
(assoc-in u (list :profile :name) "Ada")
```

Missing key → `nil` (= `'()`). Only `#f` is false — `nil` is truthy.

```scheme
;; defaults: null?, never (if x x d) or (or x d)
(if (null? (:timeout cfg)) 30 (:timeout cfg))
```

```scheme
(take xs n)                        ; list first
(sort nums >)                      ; project fields, then sort nums
(frequencies (map :kind items))    ; count-by-key — not fold/reduce
(str "x=" n)  (join ", " names)    ; join: sep first
```

```scheme
(let* ((xs (filter (lambda (e) (equal? (:kind e) "click")) events))
       (ns (sort (map :n xs) >)))
  (take ns 2))
;; bad  (sort xs (lambda (a b) (> (:n a) (:n b))))
;; bad  (take 2 xs)
```

`set!` · mutators forbidden.
