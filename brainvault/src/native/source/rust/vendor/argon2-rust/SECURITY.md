# Security Policy

## Audit status

`argon2-rust` implements security-sensitive cryptographic code. It has not yet
received an independent third-party security audit. The project's test suite,
sanitizer coverage, Miri checks, and fuzzing are defense-in-depth measures, not
a substitute for an audit.

## Supported versions

The latest `1.x` release receives security fixes. Older `1.x` minors may not.
Users should upgrade promptly when a new release is published.

## Reporting a vulnerability

Do not report suspected vulnerabilities in a public issue or discussion.
Instead, use GitHub's
[private vulnerability reporting](https://github.com/Brooooooklyn/argon2-rust/security/advisories/new)
to share the details with the maintainer.

Include enough information to reproduce and assess the issue when possible:

- the affected version or commit;
- the affected target, CPU backend, and enabled features;
- a minimal reproducer or proof of concept;
- the expected and observed behavior; and
- the potential security impact.

If private vulnerability reporting is unavailable, open a public issue asking
for a private contact method without including any vulnerability details.
