;; A second bound for the J page: the payee's secret may become public on chain, and no abort. It puts
;; the H1 boundary cases with a public secret in reach (a finalize before the deadline lands when the
;; secret is public), which the base page, where the secret never appears, cannot show.
(define secret-reveals 1)
(define max-aborts 0)
