;; Planted bug (R-SWAP-ONCHAIN, R-SWAP-ALLOWANCES): the finalize does not revert a clause that changes a delta it has no
;; allowance for, so a dispute starts from a body the chain could not settle. Run it with a clause that carries no allowance
;; and the allowance property removed (configs/swap-no-allowance-property.scm + bugs/swap-clause-no-allowance.scm): the
;; dispute step property is then the only one that sees it.
(define (finalize-reverts? w) #f)
