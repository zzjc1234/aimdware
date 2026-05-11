# Threat model

aimdware provides **visibility** for honest students and **friction**
for casual non-compliance. It is **not** an enforcement system against
adversarial students. An adversary controls their own machine and can
trivially bypass it; that is a property of the architecture, not a bug.

## Assumptions

- The student controls the runtime — router runs with their privileges.
- The student supplies the LLM credential; the university does not.
- The router is open source; modifying it is easy.
- Network egress is unrestricted.

Under these, no client-side software can guarantee monitoring.

## What aimdware protects against

- **Casual non-compliance** — students who'd comply if the path of
  least resistance is the official channel.
- **Accidental violations** — students unaware AI use needed disclosure.
- **Server-side data leaks** — backend stores no content, only
  metadata + hash + URI. A full DB compromise yields no student work.
  Write-only ingest bounds a stolen course token to writes for one
  (student, course).

## What it does NOT protect against

- **Adversarial bypass.** Skipping the router, running a modified
  build, using a second unmonitored agent, using a friend's account,
  using non-AI help that looks AI-y. None detectable.
- **Hash gaming.** A modified router can compute the hash over a
  doctored payload; the backend sees consistent hash + content.
  Requires modifying the source.
- **Self-reported metadata.** Router version, agent client id, model
  string — a modified router can lie. Treat as advisory.
- **Subscription TOS.** If subscription support ever lands, students
  are responsible for compliance with the LLM provider's terms
  (Anthropic's Feb 2026 policy bans third-party OAuth use).

## Practical implications

**For the teaching team**: data is authoritative about students who
used the router, silent about those who didn't. Useful for pedagogical
conversations, not adjudication. Combine with style/skill consistency
checks, oral defense, and in-class assessment.

**For course policy**: anchor on _disclosure_, not surveillance.

> AI use in graded work must be disclosed. Routing AI use through
> aimdware constitutes disclosure. Undisclosed AI use on graded work is
> treated as undisclosed assistance.

The violation is the undisclosed-ness, not the not-using-the-router-ness.

**For students**: framing in the onboarding doc:

> The router is the course's official channel for AI use. It satisfies
> disclosure. Your API keys stay on your machine. The teaching team
> sees prompts and responses you route through it.

Honest framing builds trust and adoption. Pretending the router
enforces anything it doesn't will erode trust the moment a student
finds a bypass.

## What would change the threat model

Real enforcement requires university-held LLM credentials behind a
server-side gateway, or proctored lab environments with firewalled
egress. Neither is in scope; if either becomes a requirement, the
system needs to be redesigned, not extended.
