# Issue tracker: Local Markdown

Matt Pocock skill specs and tickets live in `.scratch/<feature-slug>/`, separately
from the owner's release queue in `todo.md`. Tracker operations update these local
records. Follow [AGENTS.md](../../AGENTS.md) for project scope, execution hosts,
financial authority, Git operations and release gates. Before domain exploration,
read [domain.md](domain.md).

## Conventions

- Spec: `.scratch/<feature-slug>/spec.md`.
- Implementation tickets: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, one file
  per ticket, numbered from `01` in dependency order.
- Each implementation ticket has `Type: implementation`, `Completed: no`,
  acceptance criteria, `Blocked by:` ticket numbers or `None`, and one `Status:`
  from [triage-labels.md](triage-labels.md).
- Triaged incoming requests also state `Category: bug` or `Category: enhancement`.
- Append discussion under `## Comments` in the relevant record.

## Skill operations

- Publish a spec or ticket by writing its file in the feature directory. Create
  directories when there is an actual record to write.
- Fetch a ticket by its file path. Resolve a bare number within the specified
  feature; ask for the feature when the reference is ambiguous.
- Select implementation tickets with `Status: ready-for-agent`, `Completed: no`
  and all blockers complete. Set `Completed: yes` only when every acceptance
  criterion is checked and the ticket records the relevant verification evidence.
  This field defines implementation completion independently of the triage role.
- Keep substantive domain documentation under `docs/`. Preserve the owner's
  `todo.md` when publishing or updating these working tracker records.
- External issue URLs are source references. External posting or mutation needs
  authorization; this local setup requires no GitHub labels or issue creation.

## Wayfinding operations

- Map: `.scratch/<effort>/map.md` with destination, notes, decision links,
  unspecified questions and scope boundaries.
- Child question: `.scratch/<effort>/issues/<NN>-<slug>.md`, with `Type:` set to
  `research`, `prototype`, `grilling` or `task` and `Blocked by:` question numbers.
- Wayfinding lifecycle uses `Status: open`, `Status: claimed`, `Status: resolved`
  or `Status: closed`, separately from implementation-ticket triage roles.
- Allocate unique numbers within each `issues/` directory. Use `Type:` to distinguish
  implementation tickets from decision questions, including when they share a directory.
- Frontier: decision questions with `Status: open` whose blockers are resolved,
  in numeric order. Implementation tickets are excluded from this query.
- Claim: record `Status: claimed` and the owner before work.
- Resolve: append `## Answer`, set `Status: resolved`, then add a gist and link to
  the map's decisions index. Promote durable domain decisions into `docs/` as needed.
- Exclude an out-of-scope question with `Status: closed`; record its reason and link
  under the map's Out of scope, rather than its decisions index. A closed question
  does not satisfy a dependency: revise or exclude dependent questions explicitly.

Working tracker records do not authorize branches, worktrees, signing or deployment;
use AGENTS.md for those boundaries and the established execution handoff.
