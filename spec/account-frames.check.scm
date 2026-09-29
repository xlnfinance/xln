;; Check the Account frames page: every reachable state, every property.
;;   node arrival/packages/arrival-cli/dist/cli.js run account-frames.check.scm   (from spec/)
(require "lib/vocabulary.scm")
(require "lib/check.scm")
(require "account/frames.scm")
(check account-frames)
