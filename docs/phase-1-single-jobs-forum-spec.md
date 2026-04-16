# Phase 1 Spec: Single Jobs Forum + Developer Access Tiers

## Goal

Ship the first marketplace pricing and visibility model without breaking the current privacy-first bot architecture.

Phase 1 must:

- move all public jobs into one public jobs forum
- keep all public job posts bot-authored
- keep developer plans as `Bronze / Silver / Gold`
- add a per-job developer access badge:
  - `Bronze Access`
  - `Silver Access`
  - `Gold Access`
- allow all developers to see all public job posts
- only allow eligible developers to apply
- keep trust score, moderation, feedback, and reports as the real trust layer

Phase 1 does **not** add client subscriptions.

## Core Product Decisions

### 1. Subscription means commitment and extra support, not trust

Public messaging should be:

- `Gold members are more committed and get more support/tools.`

Public messaging should **not** be:

- `Gold members are more trustworthy because they paid.`

Trust continues to come from:

- trust score
- moderator review
- feedback history
- reports and manual admin actions

### 2. Clients do not get monthly subscriptions

For clients, monthly plans are a weak fit because hiring is sporadic.

Client monetization should be per-job service levels:

- `Free`
- `Priority`
- `Managed`

In Phase 1, we should add the data model and UI hooks for service levels, but it is acceptable to ship with `Free` as the default and only operationally enable `Priority` / `Managed` later.

### 3. One public jobs forum is better than tiered job forums at current liquidity

With low job volume, splitting jobs across multiple public channels makes the marketplace look empty.

One jobs forum gives:

- stronger activity perception
- easier browsing
- better job discovery
- one place for developers to watch

## Terminology

### User-facing terms

- `Bronze / Silver / Gold` = developer subscription levels
- `Bronze Access / Silver Access / Gold Access` = required developer tier for a specific job
- `Free / Priority / Managed` = client service level for a specific job

### Internal compatibility

The current codebase uses the enum:

- `gold`
- `silver`
- `copper`

For Phase 1, the recommended approach is:

- keep the internal enum as-is for compatibility
- change all public-facing `copper` labels to `Bronze`

This avoids a risky data migration in the first rollout.

## Recommended Scope Split

### Must ship in Phase 1

- one public jobs forum
- per-job developer access tier
- public access badge in the job post
- apply gating by developer tier
- public UI wording changes from `Market` to `Developer Access` where relevant
- `Bronze` label instead of `Copper` in user-facing strings

### Can be staged immediately after Phase 1

- one unified client desk
- one unified developer desk
- paid checkout integration for developer subscriptions
- public `Priority` / `Managed` service badges
- admin workflow for managed sourcing

## Data Model Changes

## Recommended target model

### `JobRecord`

Add:

- `requiredDevTier: Tier`
- `serviceLevel: "free" | "priority" | "managed"`
- `publicThreadId?: string`

Deprecate:

- `marketTier`
- `visibilityTiers`
- `publishedPostIds`

Rationale:

- `marketTier` currently mixes forum routing and access gating
- in the new model, forum routing is no longer tier-based
- `requiredDevTier` is the real business concept
- `publicThreadId` is simpler than a tier-keyed map when there is only one jobs forum

## Minimal-risk migration option

If you want the smallest code change first, this is acceptable for Phase 1:

- keep `marketTier` in storage
- reinterpret `marketTier` as `requiredDevTier`
- keep `publishedPostIds`
- only use one forum ID for all future publish/update calls

This is the fastest rollout path.

The tradeoff is semantic debt in the code.

## `AccessRecord`

Current model:

- one `tier` shared across kinds in [models.ts](../src/domain/models.ts)

Phase 1 recommendation:

- keep the current structure
- treat `tier` as the developer subscription tier when the account has `developer` access
- do not treat it as a client subscription tier

This keeps the current access system usable while removing client subscription logic from the product model.

## Config Changes

In [config.ts](../src/config.ts), replace tiered public job forums with one public jobs forum.

### Add

- `JOBS_FORUM_ID`

### Deprecate for jobs

- `GOLD_OPPORTUNITIES_FORUM_ID`
- `SILVER_OPPORTUNITIES_FORUM_ID`
- `COPPER_OPPORTUNITIES_FORUM_ID`

Keep the talent forum IDs unchanged for now.

## Discord UX Changes

## Public job post

Public jobs should remain bot-authored.

Each public job post should show:

- title
- budget
- timeline
- skills
- overview
- status
- `Developer Access: Bronze Access / Silver Access / Gold Access`
- optionally later: `Service: Priority / Managed`

Recommended button layout:

- `Apply`

Do not try to hide the button per user.
All developers can see and click it.
The bot should enforce eligibility on click.

## Private job room (`job-tkt`)

The private job room should show:

- `Developer Access`
- `Service Level`

Recommended labels:

- `Developer Access: Bronze Access`
- `Service Level: Free`

## Job creation modal

Replace the old market-tier framing with two job-specific choices:

- `Developer Access`
- `Service Level`

For the first implementation, the UI can be:

- keep the existing text modal for job details
- add selection buttons before the modal opens
- or add a follow-up button step after the modal

Because Discord modals do not support dropdowns or buttons inside the modal itself, the cleanest implementation is:

1. client clicks `New Job`
2. bot shows a small ephemeral choice panel:
   - `Bronze Access`
   - `Silver Access`
   - `Gold Access`
3. after access tier is chosen, show the job modal
4. service level can default to `Free` in Phase 1

## Developer application rules

All developers can see all public jobs.

Apply eligibility:

- Bronze developer can apply only to `Bronze Access`
- Silver developer can apply to `Bronze Access` and `Silver Access`
- Gold developer can apply to `Bronze Access`, `Silver Access`, and `Gold Access`

When a developer is blocked, reply ephemerally:

- `This job is limited to Silver and Gold developers.`
- or
- `This job is limited to Gold developers.`

## Service-Level Definitions

These are **client-side per-job service levels**, not account subscriptions.

## `Free`

Default posting path.

What the client gets:

- bot-authored public job post
- standard visibility in the jobs forum
- normal private job room
- normal applicant flow
- normal shortlist and suggestion tools

What the client does not get:

- admin-managed sourcing
- manual boost
- concierge handling

Recommended access rule:

- `Free` jobs should default to `Bronze Access`

Reason:

- if free clients can select `Gold Access` too often, the access badge loses value

## `Priority`

One-time paid upgrade for one job.

What the client gets:

- boosted visibility treatment
- faster admin attention
- one manual bump or refresh
- stronger candidate outreach support
- better operational priority without full concierge service

What `Priority` does **not** mean:

- guaranteed hire
- guaranteed trust
- guaranteed candidate quality

Recommended access rule:

- `Priority` can choose `Bronze Access` or `Silver Access`

## `Managed`

Highest-touch client service.

What the client gets:

- admin-assisted job shaping
- manual candidate sourcing
- curated shortlist help
- stronger follow-up and coordination support
- more hands-on hiring assistance

Recommended access rule:

- `Managed` can choose `Bronze Access`, `Silver Access`, or `Gold Access`

This makes `Gold Access` feel earned and scarce instead of being the default client choice.

## Access and Suggestion Logic

## Apply flow

Current logic uses:

- [AccessService.ts](../src/services/AccessService.ts)
- [tier.ts](../src/utils/tier.ts)

Phase 1 should preserve the tier ordering logic and reuse it for job access.

Implementation rule:

- compare developer tier against `requiredDevTier`

## Suggestion flow

Current suggestion logic in [JobService.ts](../src/services/JobService.ts) uses the job tier to determine eligible profiles.

Phase 1 should change that logic to:

- use `requiredDevTier`
- show only developers eligible for that job

This preserves consistency between:

- who the client can invite
- who can apply
- who appears in suggestions

## File-by-File Implementation Plan

## `src/config.ts`

- add `JOBS_FORUM_ID`
- change `forums.opportunities` from a tier map to a single forum ID, or add a new single-forum field and migrate call sites

## `src/domain/models.ts`

Recommended:

- add `requiredDevTier`
- add `serviceLevel`
- add `publicThreadId`

Minimal-risk alternative:

- keep `marketTier`
- treat it as the required developer access tier in Phase 1

## `src/utils/tier.ts`

- keep tier ordering logic
- change public label for `copper` from `Copper` to `Bronze`
- optionally add helper text for access labels:
  - `Bronze Access`
  - `Silver Access`
  - `Gold Access`

## `src/services/JobService.ts`

- publish every job into the single jobs forum
- render `Developer Access` in public and private job cards
- attach access badge text to the public job post
- enforce a single `publicThreadId` or single-forum publish target
- update profile suggestion filtering to use required developer tier
- rename UI labels away from `Market` where they now mean access gating

## `src/services/AccessService.ts`

- keep developer tier lookup logic
- continue using current tier comparison rules
- do not add client subscription logic

## `src/bot/app.ts`

- change `New Job` flow to include developer access tier selection
- default `serviceLevel` to `free`
- gate `Apply` by developer tier
- return clear ephemeral rejection messages for ineligible developers

## `src/bot/commands.ts`

- review admin access commands wording if they still imply client subscriptions

## `README.md`

- update architecture notes
- document the single public jobs forum
- document developer access tiers
- document that client service level is per-job, not monthly

## Migration Plan

## Existing data

For current jobs:

- map existing `marketTier` to the new required developer tier
- continue publishing/updating existing jobs into the single public jobs forum

For current developer access:

- keep existing access records
- reinterpret public `Copper` as `Bronze`

## Existing Discord channels

Phase 1 migration recommendation:

1. create the new single public jobs forum
2. update bot config to publish there
3. stop creating/updating posts in old tiered job forums
4. optionally archive old public opportunity threads after the transition

## Existing desks

To reduce rollout risk, desks can remain unchanged in Phase 1.

However, the recommended next step after Phase 1 is:

- one client desk
- one developer desk

That better matches the new product model.

## Rollout Order

Recommended rollout sequence:

1. relabel `Copper` to `Bronze` in user-facing copy
2. add a single jobs forum config
3. publish new jobs only to the single jobs forum
4. add `Developer Access` display and apply gating
5. add `serviceLevel = free` to new jobs
6. later enable `Priority` and `Managed` operationally

## Product Guardrails

- paid access tiers must never be presented as trust guarantees
- trust score and moderation must remain visible and distinct from payment
- not every client should be able to create `Gold Access` jobs by default
- `Gold Access` should stay scarce enough to feel valuable
- lower-tier developers should still see marketplace activity so they do not disengage

## Recommended Phase 1 Decision

Ship this exact version first:

- one public jobs forum
- bot-authored public posts
- `Bronze / Silver / Gold` developer plans
- per-job `Developer Access` badge
- all developers can view all jobs
- only eligible developers can apply
- client service level stored as `free` by default

Then add:

- `Priority`
- `Managed`
- desk consolidation
- billing integration
