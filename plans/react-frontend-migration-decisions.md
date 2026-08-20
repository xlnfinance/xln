# React frontend migration — owner decision contract

> **Gate state:** `DERIVED — NEVER HANDWRITTEN`
>
> This file records the questions that must be answered before any React
> implementation begins. Editing an answer or a status label is not approval.
> Gate state is derived from currently verifiable, hash-bound GitHub records
> plus append-only approval manifests; it is never established by writing
> `APPROVED` into this file.

## Non-self-referential approval protocol

The reviewed subject is the byte-exact pair of:

- `plans/react-frontend-migration.md`;
- `plans/react-frontend-migration-decisions.md` with explicit D1–D8 answers.

After the answers and charter agree, commit those two files without an approval
manifest. That full commit is `SUBJECT_COMMIT`. Its Git blob IDs are the stable
approval subject. The owner reviews that already-existing commit externally;
only afterward may a separate manifest be added under:

```text
plans/approvals/react-frontend-migration/<SUBJECT_COMMIT>/gate-a.json
plans/approvals/react-frontend-migration/<SUBJECT_COMMIT>/gate-b.json
```

The path is knowable before the manifest commit and the manifest never contains
its own commit SHA. Reapproval uses a new subject commit and directory; approval
manifests are append-only and must never be edited or overwritten.

The approval pull request must stop changing at `SUBJECT_COMMIT`. After its
owner comment and independent review validate, merge it by fast-forward or merge
commit so `SUBJECT_COMMIT` remains an ancestor with the reviewed blob IDs; squash
and rebase merges are forbidden. Add `gate-a.json` afterward in a separate
governance-only pull request based on that merged state. Never push the manifest
onto the approval pull request: a new commit can stale or dismiss its review and
would change the reviewed head. Gate B uses the same two-pull-request sequence:
the accepted Work Package 0 pull request stops at `FOUNDATION_COMMIT`, merges
without rewriting it, and a separate governance-only pull request adds
`gate-b.json`.

### Gate A manifest

`gate-a.json` must contain exactly this information, with placeholders replaced
by values returned by the GitHub REST API for `xlnfinance/xln`. Every `0` below
means a positive GitHub integer ID; it is not a permitted stored value:

```json
{
  "schemaVersion": 1,
  "programId": "react-frontend-migration",
  "repository": "xlnfinance/xln",
  "gate": "A",
  "subjectCommit": "<full-git-commit-id>",
  "approvalPullRequest": 0,
  "subjectBlobs": {
    "plans/react-frontend-migration.md": "<git-blob-id>",
    "plans/react-frontend-migration-decisions.md": "<git-blob-id>"
  },
  "ownerApproval": {
    "recordType": "issue_comment",
    "recordId": 0,
    "url": "<github-issue-comment-html-url>",
    "githubUserId": 0,
    "createdAt": "<github-created-at>",
    "updatedAt": "<same-value-as-created-at>",
    "payloadSha256": "<sha256-of-canonical-github-payload>"
  },
  "independentReview": {
    "recordType": "pull_request_review",
    "recordId": 0,
    "url": "<github-pull-request-review-html-url>",
    "githubUserId": 0,
    "submittedAt": "<github-submitted-at>",
    "commitId": "<same-full-git-commit-id-as-subjectCommit>",
    "state": "APPROVED",
    "payloadSha256": "<sha256-of-canonical-github-payload>"
  },
  "implementationAuthorGithubUserId": 0
}
```

All identities are GitHub REST numeric `user.id` values. The numeric ID is the
authority and separation key; display names, email addresses, Git commit author
strings, and mutable GitHub logins are never authority. The validator may print
the current GitHub login for a human-readable diagnostic, but it must obtain it
from GitHub for the stored numeric ID. The Gate A owner ID is frozen in the
confirmed D8 answer before `SUBJECT_COMMIT`; the owner comment's `user.id` must
equal it. `implementationAuthorGithubUserId` is copied from the approval pull
request's `user.id`, not entered from memory. The review's `user.id` is its
reviewer. For Gate A, the copied PR-author ID must also equal the D6-approved
subject-PR author ID `966176`. These three IDs must be pairwise distinct.

| Manifest/decision value | Authoritative GitHub REST source | Purpose |
|---|---|---|
| D8 program-owner ID | authenticated owner's `GET /user` response `id` | anchors who may issue both gate owner assertions |
| D6 Gate A subject-PR author ID | owner-selected `pavelivanov`, resolved through `GET /users/pavelivanov` response `id` | pins which non-owner account must open the frozen-subject PR |
| `implementationAuthorGithubUserId` | `GET /repos/xlnfinance/xln/pulls/{pull_number}` response `user.id`; for Gate A it must equal the D6 value | prevents the approval PR author from supplying the independent review |
| `independentReview.githubUserId` | the exact pull-request review response `user.id` | proves an independent GitHub actor approved the bound commit |
| `ownerApproval.githubUserId` | the exact issue-comment response `user.id` | proves the gate token came from the D8 owner account |
| `releaseOperatorGithubUserId` and `rollbackOperatorGithubUserId` | owner-selected accounts resolved through `GET /users/{login}` response `id`, then repeated in the exact Gate B owner token | binds production activation and rollback entry points to named accounts |
| `recordId`, URL, timestamps, state, and `commitId` | the exact issue-comment or pull-request-review REST response | lets the validator re-fetch the assertion and reject edits, deletion, dismissal, or another commit |

The owner must add an unedited issue comment to `approvalPullRequest` whose body
is exactly this single ASCII line, with the placeholder replaced:

```text
XLN_REACT_MIGRATION_GATE_A_APPROVED SUBJECT_COMMIT=<full-git-commit-id>
```

The independent reviewer must submit a GitHub pull-request review on that same
pull request with state `APPROVED`, `commit_id == SUBJECT_COMMIT`, and this exact
single-line body:

```text
XLN_REACT_MIGRATION_GATE_A_REVIEWED SUBJECT_COMMIT=<full-git-commit-id>
```

GitHub issue comments are mutable, so the protocol does not pretend the comment
itself is immutable. It makes mutation fail closed: `created_at` must equal
`updated_at`, the current record must exist, and its current body and actor must
still match the manifest. A deleted, edited, transferred, unresolved, dismissed,
or inaccessible record invalidates the gate. A bare URL, ordinary PR comment,
review comment, approval reaction, filled Markdown checkbox, or commit status is
not an approval record.

The validator fetches records from GitHub by repository, pull-request number,
and integer record ID using raw-body media types. It requires the API-returned
`html_url` to equal the manifest URL and rejects any other host, repository, or
pull request. For schema version 1, each `payloadSha256` is SHA-256 over UTF-8
bytes of these exact newline-delimited fields with no trimming:

- owner comment: `v1`, `github`, repository, `issue_comment`, pull-request
  number, record ID, `user.id`, `created_at`, `updated_at`, and SHA-256 of the
  raw API-returned body string;
- independent review: `v1`, `github`, repository, `pull_request_review`,
  pull-request number, record ID, `user.id`, `submitted_at`, `commit_id`,
  uppercase state, and SHA-256 of the raw API-returned body string.

Tests must freeze both normalizations and prove that any authoritative field,
body, timestamp, commit, actor, or current review-state change invalidates the
gate. The implementation author may generate the manifest mechanically, but
must not invent or substitute an owner's or reviewer's assertion.

This GitHub numeric-ID rule applies to every later human role in the program:
scope approver, final-head reviewer, removal approver, evidence reviewer,
release operator, and rollback operator. Approval evidence must be an exact
GitHub issue comment or `APPROVED` pull-request review with the same current
record/hash checks. A plan may narrow which roles must be distinct, but it may
not introduce another identity provider or use login/name/email as authority.

The Gate A activation commit may add only `gate-a.json` and derived index status
text; any implementation-path change keeps the program `BLOCKED`.

### Gate B manifest

After Work Package 0 is accepted at `FOUNDATION_COMMIT`, the owner and
independent reviewer approve Gate B for both `SUBJECT_COMMIT` and
`FOUNDATION_COMMIT`. `gate-b.json` must contain exactly this schema with new
Gate-B-specific GitHub records:

```json
{
  "schemaVersion": 1,
  "programId": "react-frontend-migration",
  "repository": "xlnfinance/xln",
  "gate": "B",
  "subjectCommit": "<full-git-commit-id>",
  "approvalPullRequest": 0,
  "subjectBlobs": {
    "plans/react-frontend-migration.md": "<git-blob-id>",
    "plans/react-frontend-migration-decisions.md": "<git-blob-id>"
  },
  "ownerApproval": {
    "recordType": "issue_comment",
    "recordId": 0,
    "url": "<github-issue-comment-html-url>",
    "githubUserId": 0,
    "createdAt": "<github-created-at>",
    "updatedAt": "<same-value-as-created-at>",
    "payloadSha256": "<sha256-of-canonical-github-payload>"
  },
  "independentReview": {
    "recordType": "pull_request_review",
    "recordId": 0,
    "url": "<github-pull-request-review-html-url>",
    "githubUserId": 0,
    "submittedAt": "<github-submitted-at>",
    "commitId": "<same-full-git-commit-id-as-foundationCommit>",
    "state": "APPROVED",
    "payloadSha256": "<sha256-of-canonical-github-payload>"
  },
  "implementationAuthorGithubUserId": 0,
  "foundationCommit": "<full-git-commit-id>",
  "foundationEvidenceManifestSha256": "<sha256>",
  "foundationEvidenceArtifactUrl": "<immutable-artifact-url>",
  "releaseOperatorGithubUserId": 0,
  "rollbackOperatorGithubUserId": 0
}
```

The Gate B owner comment must be unedited and its body must be exactly this one
line; the two operator IDs are copied from GitHub REST `/users/{login}` results
and frozen by the owner's assertion, not selected by the manifest author:

```text
XLN_REACT_MIGRATION_GATE_B_APPROVED SUBJECT_COMMIT=<full-git-commit-id> FOUNDATION_COMMIT=<full-git-commit-id> EVIDENCE_SHA256=<64-lowercase-hex> RELEASE_OPERATOR_GITHUB_USER_ID=<positive-integer> ROLLBACK_OPERATOR_GITHUB_USER_ID=<positive-integer>
```

The independent GitHub review must have state `APPROVED`,
`commit_id == FOUNDATION_COMMIT`, and exactly this body:

```text
XLN_REACT_MIGRATION_GATE_B_REVIEWED SUBJECT_COMMIT=<full-git-commit-id> FOUNDATION_COMMIT=<full-git-commit-id> EVIDENCE_SHA256=<64-lowercase-hex>
```

The owner-comment actor must equal the D8 program-owner GitHub ID. The review
actor must differ from the owner, implementation author, and release operator.
The release and rollback operator may be the same GitHub ID so one on-call
operator is sufficient. The Gate B activation commit may add only `gate-b.json`
and derived index status text. Both records must predate that activation commit.
Later child plans receive independent final-head review; Gate B is program
authorization, not approval of later code.

### Required validator behavior

Work Package 0 creates one validator with these two invocations:

```bash
bun frontend/scripts/validate-program-approval.ts --gate=A --subject-commit="$SUBJECT_COMMIT"
bun frontend/scripts/validate-program-approval.ts --gate=B --subject-commit="$SUBJECT_COMMIT"
```

It must fail unless all of these hold:

- the manifest uses the exact versioned schema, fixed program/gate/path, full
  repository object IDs, and contains no unknown or duplicate JSON keys;
- `SUBJECT_COMMIT` exists and is an ancestor of the current head;
- each declared subject blob equals both `SUBJECT_COMMIT:<path>` and the current
  head's blob for that path;
- the manifest path contains the same subject commit and its Git history proves
  it was added once and never modified;
- the external records resolve, explicitly approve the named gate/commit(s),
  match their canonical payload hashes, and predate the manifest-addition
  commit; GitHub/network/auth failure is blocking and no stale cache passes;
- the GitHub issue comment and pull-request review belong to the declared
  approval pull request; their REST record IDs, numeric actor IDs, exact bodies,
  timestamps, review state, and commit bindings satisfy the gate-specific rules;
- owner, independent-reviewer, release-operator, and rollback-operator IDs
  resolve to active GitHub `User` accounts; an organization, deleted account,
  or bot cannot occupy a human authority role;
- the approval pull request's GitHub author matches
  `implementationAuthorGithubUserId`; Gate A additionally matches the D6-fixed
  subject-PR author ID, and every identity satisfies the gate-specific
  separation rules;
- the manifest-addition commit changes no implementation path; Gate B permits
  only its manifest plus derived index status after `FOUNDATION_COMMIT`;
- Gate B's foundation commit is an ancestor, its evidence hash and immutable
  artifact resolve, the canonical root gate recorded there is green, and its
  owner comment freezes the exact release/rollback operator IDs in the manifest.

The validator prints exactly one derived state:

- `BLOCKED` when no applicable manifest validates;
- `OWNER_RECORDED` when Gate A validates, authorizing Work Package 0 only;
- `APPROVED` when Gate B validates, authorizing later child plans subject to
  their own prerequisites and reviews.

Any subject-file byte change invalidates both gates. Freeze a new subject commit,
obtain new external approvals, and add new manifests; never edit the old ones.

## Confirmed owner decisions

On 2026-08-20, the project owner confirmed the complete D1–D8 answer set below
and identified the owner account as GitHub login `homakov`. GitHub REST resolved
that account to numeric `user.id` `174693` with type `User`; `174693` is the
authority value and the login is display-only. The owner selected GitHub login
`pavelivanov` for the Gate A subject-PR author; GitHub REST resolved it to
numeric `user.id` `966176` with type `User`. This confirmation settles the
decision content but is not Gate A approval. Gate A still requires the frozen
`SUBJECT_COMMIT`, exact owner comment, and independent GitHub review defined
above. The owner intentionally did not preselect the independent reviewer: a
human reviewer is selected only after the subject PR is open and byte-final,
and their numeric ID is accepted only from its final `APPROVED` GitHub review.
Release and rollback operator IDs are selected later in the Gate B owner record;
later reviewer and implementation-author IDs are derived from their GitHub
records.

### D1 — Product parity and removals

- Is exact behavioral parity required for every reachable current capability?
- If removals are allowed, who may approve them and what evidence is required?
- May a test be retired only after the unchanged baseline assertion passes
  against React, or may the owner approve a behavior change explicitly?

**Owner-approved answer:** `EXACT_PARITY`. Every
reachable baseline item must be marked `RETAIN_BEHAVIOR` or
`REPLACE_IMPLEMENTATION`. No removal is permitted inside this migration. A
removal requires a separately reviewed product-change subject before its
migration child plan. An unchanged baseline behavior assertion must pass against
React before its implementation-specific test may retire; replacement coverage
is additive and separately reviewed.

**Current answer:** `EXACT_PARITY`

### D2 — Application boundaries

- Is the target exactly `site`, `docs`, `wallet`, and `ops`?
- If Ops is excluded, identify the canonical owner of `/health`, `/qa`,
  `/qa/hlt`, `/runs`, `/scenarios`, `/ai`, and `/embed`.
- Approve the complete route-owner table, including redirects and server-only
  paths, rather than only the four application names.

**Owner-approved answer:** approve exactly these
same-origin owners, with Ops included:

| Owner | Route families |
|---|---|
| `site` | `/`, `/install`, `/rcpan`, `/releases`, `/reviews`, `/unicast`, `/market-cap` |
| `docs` | `/docs` plus docs-catalog/static/`llms*` assets |
| `wallet` | `/app`, `/address`, `/address/:entityId`, `/testnet` |
| `ops` | `/health`, `/qa`, `/qa/hlt`, `/runs`, `/scenarios`, `/ai`, `/ai/:chatId`, `/embed` |
| edge/server | `/admin`, `/radapter`, `/resetdb`, `/api/**`, `/api/tower/**`, `/rpc`, `/rpc2`–`/rpc8`, `/relay`, `/runtime.js`, named static assets, and unknown-path dispatch |

Every route and asset discovered by Work Package 0 must map to exactly one row;
an unlisted reachable route blocks rather than being assigned by inference.

**Current answer:** `FOUR_APPLICATION_SPLIT_WITH_EXACT_ROUTE_TABLE`

### D3 — Build and deployment independence

- Does “separate apps” mean independent checks/build outputs inside one atomic
  same-origin release, or independently deployable production releases?
- If one release remains canonical, approve one shared release identity and
  immediate whole-release rollback.

**Owner-approved answer:** applications have
independent strict checks, preparation, build outputs, and artifact manifests,
but production uses one versioned same-origin release identity, one atomic
activation, and immediate whole-release rollback. Independent production
versions or partial application rollout are forbidden.

**Current answer:** `INDEPENDENT_BUILDS_ATOMIC_RELEASE`

### D4 — Migration coexistence

- May Svelte remain canonical while release-blocked React artifacts coexist in
  non-production output directories?
- Confirm that no runtime selector, compatibility reader, or second production
  path may exist at any point.

**Owner-approved answer:** Svelte remains the only
canonical dev/build/package/deploy selection until authorized atomic cutover.
React artifacts may coexist only in production-unreachable, manifest-separated
candidate directories. No runtime selector, compatibility reader/writer,
fallback root, traffic split, or second production path is allowed.

**Current answer:** `SVELTE_CANONICAL_UNTIL_ATOMIC_CUTOVER`

### D5 — Release-blocking capabilities

Explicitly classify each of these as `RETAIN`, `REMOVE`, or `OUT_OF_SCOPE_WITH_OWNER`:

- remote Runtime discovery and admin attachment;
- recovery tower onboarding, recovery, and push wake;
- Time Machine, IndexedDB/LevelDB inspection, and diagnostics;
- Graph3D, Architect, Jurisdiction, Runtime I/O, console, and Dockview layout;
- command palette, localization, theme, mascot, AI, QA, and HLT surfaces;
- native deep links, offline/PWA behavior, mobile, desktop, and extension packaging;
- payment, receive, invoice, move, lending, settlement, market, and dispute flows.

**Owner-approved answer:** `RETAIN` every listed
capability group. `REMOVE` and `OUT_OF_SCOPE_WITH_OWNER` are not approved by
default. Any desired exception must name individual capability IDs and enter a
new owner-reviewed subject; an incomplete retained capability blocks cutover.

**Current answer:** `RETAIN_ALL_LISTED_CAPABILITIES`

### D6 — Pull-request workflow exception

`AGENTS.md` currently requires work on `main` unless the owner explicitly asks
for another workflow. Approve or reject the charter's short-lived pull-request
workflow and identify the branch/review convention to use.

**Owner-approved answer:** approve a narrow exception
for this migration program because SHA-bound final-head review is a postmortem
control. Use one non-stacked short-lived branch per accepted child plan named
`codex/react-frontend-wp<NN>-<slug>`, one draft PR, manual final-head approval by
a human other than the author, no auto-merge, and branch deletion after merge.
Use `codex/react-frontend-subject`, `codex/react-frontend-gate-a`, and
`codex/react-frontend-gate-b` only for the bootstrap/governance PRs defined by
the approval protocol. Every merge is fast-forward or a merge commit that
preserves the reviewed final-head commit as an ancestor; squash/rebase merge is
forbidden. No branch may mix child plans or Runtime/protocol work. This decision
authorizes `codex/react-frontend-subject` to freeze and review the confirmed
bytes, and that pull request must be authored by GitHub numeric `user.id`
`966176` (login at confirmation: `pavelivanov`, display-only). The Gate A
independent reviewer is selected at PR time, not frozen in this decision. Their
final `APPROVED` review record must resolve to an active human GitHub `User`
whose numeric ID differs from both owner `174693` and PR author `966176`. The
Gate A governance branch may start only after that subject PR merges; Work
Package branches still require the applicable validated gate and accepted child
plan.

**Current answer:** `NARROW_SHA_PRESERVING_PR_EXCEPTION — SUBJECT_PR_AUTHOR_GITHUB_USER_ID=966176 — REVIEWER_SELECTED_AT_PR_TIME`

### D7 — Route, asset, redirect, and development-gateway contract

Approve an exact table containing, for every route family:

- HTML/application owner and artifact entry;
- fixed asset namespace and `base` value;
- direct-load/deep-link fallback behavior;
- redirect status, target, and query/hash rules;
- API/RPC/proxy owner that must never be shadowed by an SPA fallback;
- development port, HMR/WebSocket routing, CSP, service-worker, and native owner.

The table must preserve at least the current `/admin` 308 redirect to `/health`
and `/radapter` query rejection followed by its 307 redirect to `/app`, unless
the owner explicitly approves a product change.

**Owner-approved answer:** approve this route and
asset contract without product-behavior changes:

| Family | HTML/artifact owner | Vite `base` / `assetsDir` and fixed assets | Direct-load behavior |
|---|---|---|---|
| D2 `site` routes | `site/index.html` | `base: "/"`; `assetsDir: "assets/site"` | exact route match; direct load returns site HTML |
| D2 `docs` routes | `docs/index.html` | `base: "/"`; `assetsDir: "assets/docs"`; `/docs-catalog/**`, `/llms*.txt` | `/docs` direct load returns docs HTML |
| D2 `wallet` routes | `wallet/index.html` | `base: "/"`; `assetsDir: "assets/wallet"`; `/contracts/**`, `/brainvault-worker.js`, `/hash-wasm-*.js`, `/push-wake-sw.js`, `/route-mode.js` | `/app`, `/address/**`, and `/testnet` direct loads return wallet HTML |
| D2 `ops` routes | `ops/index.html` | `base: "/"`; `assetsDir: "assets/ops"`; `/scenarios/**`, `/comparative-results.json` | exact ops route/direct load returns ops HTML |
| shared assembly | no SPA owner | `/runtime.js`, root manifest/icons/install/media and the release manifest | exact named asset only; hash and consumer ownership required |

- `/admin` remains HTTP 308 to `/health`; its fixed target does not forward the
  incoming query. `/radapter` with any query remains HTTP 400
  `REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN`; queryless `/radapter` remains HTTP
  307 to `/app`. Browser fragment behavior must match the frozen baseline test.
- `/resetdb` remains edge-owned and preserves its `200`, `Clear-Site-Data`,
  no-store, and refresh-to-`/app` contract. HTTP-to-HTTPS retains its current 301
  host/request-URI behavior.
- `/api/**`, `/api/tower/**`, `/rpc`, `/rpc2`–`/rpc8`, and `/relay` remain
  edge/server-owned and are tested before any SPA fallback. `/runtime.js` keeps
  its special no-store Runtime-bundle contract. Unknown GET/HEAD behavior and
  missing named-asset behavior remain byte/status-equivalent to the accepted
  Svelte baseline; the migration does not silently “improve” them.
- `localhost:8080` is the only public dev origin. The gateway owns it; internal
  ports are site `8081`, existing Runtime/API `8082`, docs `8083`, wallet `8084`,
  and ops `8085`. HMR uses gateway paths `/__hmr/site`, `/__hmr/docs`,
  `/__hmr/wallet`, and `/__hmr/ops`; every internal Vite server uses
  `strictPort: true`, its matching `server.hmr.path`, and external
  `server.hmr.clientPort: 8080`. The gateway proxies those WebSockets and
  `/api`, `/rpc*`, and `/relay` retain their current proxy/Host/audience behavior.
- Preserve the existing route-specific CSP and global security headers exactly:
  `/app` keeps its current `frame-ancestors` allowlist and other browser HTML
  remains `frame-ancestors 'self'` unless the frozen baseline proves another
  exception. The root-scoped site manifest, push-wake service worker, storage
  origin, `xln://` mapping to `/app`, and mobile/desktop/extension wallet
  consumers remain unchanged.

**Current answer:** `EXACT_ROUTE_ASSET_REDIRECT_GATEWAY_CONTRACT`

### D8 — Production activation authority

- Identify who may authorize activation, operate rollback, and accept release
  evidence.
- Confirm that activation follows `docs/mainnet-acceptance-gate.md` on one
  immutable candidate and does not compile on production.

**Owner-approved answer:** the project owner's GitHub REST numeric `user.id` is
`174693` (login at confirmation: `homakov`, display-only). That ID is the sole
activation authorizer and the trusted comparison value for both gate owner
comments. Display names, emails, Git author strings, and GitHub logins are not
authority. At Gate B, the owner comment names the GitHub numeric IDs of the
release operator and rollback/on-call operator. The release operator may install
and atomically activate only the prebuilt approved candidate; the rollback
operator may immediately restore the previous complete release on any mismatch
without waiting for new approval. Those two roles may use the same GitHub ID.
The Gate B `APPROVED` review actor is the independent evidence reviewer and must
differ from the implementation author and release operator; the project owner
gives final acceptance. Activation uses the unchanged candidate and the full
`docs/mainnet-acceptance-gate.md` loop, with no production compilation. The
reviewer/author identities come from GitHub records, so they are never manually
typed into D8. The activation and rollback entry points must compare their
authenticated initiating GitHub numeric user ID with the applicable Gate B
operator ID before changing production state; a matching login string alone is
insufficient.

**Current answer:** `GITHUB_AUTHORITY — PROGRAM_OWNER_GITHUB_USER_ID=174693`

## Approval gates

### Gate A — authorize Work Package 0 only

- every `Current answer` is replaced by an explicit owner decision;
- the charter contains no outcome that conflicts with an approved answer;
- the frozen subject commit contains both reconciled documents and its two blob
  IDs match the Gate A manifest;
- the owner and independent-review records explicitly approve Gate A for that
  subject commit before the append-only manifest is added;
- manual inspection confirms the Gate A manifest while Work Package 0 builds
  the validator; its first accepted use must retrospectively validate Gate A;
- the derived state is `OWNER_RECORDED`, authorizing only an accepted Work
  Package 0 child plan. Index text is informational and not authority.

### Gate B — approve React child plans

- Work Package 0's review-contract CI validates Gate A, the frozen subject
  commit/blob IDs, owner/reviewer numeric IDs, and current hash-bound records;
- the canonical root gate is green;
- the exhaustive baseline manifest, frozen parity corpus, route/asset contract,
  and scope/evidence controls are independently accepted;
- the accepted Work Package 0 head becomes `FOUNDATION_COMMIT` and its immutable
  evidence hash is approved externally;
- the append-only Gate B manifest validates and the validator derives
  `APPROVED`. No source file is edited merely to claim that state.

Any later change to the charter or D1–D8 changes a subject blob, invalidates both
gates and downstream evidence, and requires a new subject plus Gate A/Gate B
approval sequence before work resumes.
