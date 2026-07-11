# Security Policy

Holidayys WA CRM is an internal tool of **Holidays Tours LLC**. This policy
covers how to report a security issue in it.

## Reporting a vulnerability

Report privately to **admin@holidayys.com**. Do not post security issues in
shared team channels or the issue tracker.

Include, if you can:

- A description of the issue and its impact.
- Reproduction steps or a proof-of-concept.
- The commit or environment you're testing against.

## Scope

In scope: this application — webhook and auth flows, token encryption
(AES-256-GCM), and Convex account-scoping (`accountQuery` / `accountMutation`).

Out of scope: vulnerabilities in upstream dependencies (Convex, Next.js,
Node.js) — report those to their maintainers; we'll bump versions as needed.

© 2026 Holidays Tours LLC. Internal use only.
