# Active Agents Registry

## Agents

### Claude
- Role: implementation and integration
- Strengths: feature delivery, refactors, docs
- Branch prefix: `claude/`

### Codex
- Role: security and correctness review
- Required for: contracts, signatures, auth, ABI, settlement logic
- Review file: `codexN.md`

### Gemini
- Role: architecture and scalability review
- Required for: cross-module/runtime architecture changes
- Review file: `geminiN.md`

## Human Maintainer

### @zigota
- Final merge decision
- Resolves reviewer conflicts
- Can trigger emergency stop (`!`)

## Merge Policy (Active)
All must be true:
- Open `CRITICAL` findings = 0
- Open `HIGH` findings = 0
- Required reviewers approved
- Required tests green
- Migration notes present for breaking changes

## Reviewer Matrix
- Contracts/security/ABI/signatures: Codex required
- Cross-module architecture/runtime flow: Gemini required
- Small isolated UI/content: optional second reviewer

## Notes
- Confidence score is advisory; severity gates are binding.
- Last updated: 2026-02-12
