# Liame native GPUI migration

Status: active. Target: Windows, macOS, Linux X11 and Wayland desktop.
Mobile and browser clients are separate future projects. This plan is the
completion contract; unchecked gates remain work, including platform checks
that cannot be run on the development machine.

## Outcome and constraints

Replace Electron, React, preload IPC, and Node runtime dependencies with a
Rust application whose application UI uses GPUI. Preserve direct IMAP/SMTP,
offline operation, multiple accounts, unified inbox, conversations, search,
attachments, drafts, scheduling, keyboard controls, settings, and optional AI.
No hosted Liame service is introduced. Preserve upstream MIT attribution.

Use a migration branch and a draft PR. Each commit must represent one reviewable
behavior or infrastructure change and record relevant verification in the PR.
Do not remove the existing app before parity. Do not push to main: its workflow
publishes releases. Release credentials and external publication are separate
from producing and testing packages.

## Existing implementation and reuse

- `src/shared/types.ts`: behavior inventory and public contracts, including
  account summaries, mailbox state, messages, drafts, schedules, settings, AI.
- `src/main/mail.ts`: IMAP synchronization, connection ownership, actions.
- `src/main/store.ts`: SQLite cache, FTS, body retention, mailbox checkpoints,
  conversations and scheduled jobs. Preserve behavior, not accidental schema.
- `src/main/send.ts`: MIME composition, SMTP, attachments and sent copies.
- `src/main/account.ts`, `settings.ts`: Electron safeStorage encrypted files.
- `schedule.ts`, `context.ts`, `ai.ts`, `labels.ts`: durable jobs and optional AI.
- `src/preload/index.ts`, `src/main/index.ts`: operation/event and OS boundaries.
- `src/renderer/src`: UI behavior, shortcuts, HTML reader, localStorage contacts.
- `tests/mail-cache.test.ts`, `message-list.test.tsx`: regression scenarios to port.

React/CSS and Node libraries cannot be directly reused as GPUI/Rust components.
Reuse assets, product behavior, synthetic fixtures and regression expectations.

## Architecture decisions

Prefer a complete Rust runtime over permanently shipping a Node sidecar. A
temporary sidecar is an alternative only if a measured protocol gap warrants
it; it cannot satisfy final runtime independence. A wholesale one-shot rewrite
has excessive parity risk; implement vertical native slices alongside Electron.

Proposed workspace:

| Crate | Ownership |
| --- | --- |
| `liame-core` | Validated identities, domain values, operation states and errors |
| `liame-store` | SQLite migrations, cache, queries, durable jobs and checkpoints |
| `liame-mail` | IMAP, SMTP, TLS, MIME, sync and account workers |
| `liame-platform` | Secret vaults, paths, notifications, dialogs and URL handling |
| `liame-ai` | Opt-in provider calls, streaming, cancellation and label policy |
| `liame-app` | GPUI views, actions, view models and runtime integration |

Keep domain/storage tests runnable without a display or GPUI. UI entities own
presentation state. Background account workers own network sessions; bounded
commands/events connect them to the UI. Never block GPUI rendering on network,
database or filesystem calls. Pick executor integration after a compiled spike;
avoid nested runtimes and document shutdown/cancellation ownership.

Proposed contracts (Rust sketches, finalized in implementation):

```rust
struct MessageRef {
    account: AccountId,
    mailbox: MailboxId,
    uid_validity: u64,
    uid: NonZeroU32,
}
enum DeliveryState { Queued, Sending, Accepted, Uncertain, Failed }
enum MailError {
    Authentication, Offline, Tls, StaleMailbox, NotFound,
    Permission, InvalidInput, RateLimited, DeliveryUncertain, Storage,
}
// Credentials never appear in ordinary account summaries or diagnostic events.
// Commands carry validated domain values; events carry operation IDs/revisions.
```

Identity must include UIDVALIDITY: UIDs repeat across folders and server resets.
Mod-sequences use integer-safe representation. Account IDs isolate all data.
Message-ID/thread identifiers are not unique storage identities.

Read flow: GPUI action -> application query -> local store -> view projection;
background sync -> validated server changes -> transaction + checkpoint -> event.
Mutation flow: validated command -> durable pending operation -> account worker
-> server result -> transaction -> event. Retry only when operation semantics
permit it; reject stale mailbox generations before changing server state.

SMTP cannot guarantee exactly-once delivery after a disconnect. Persist the
submission state and stable Message-ID; ambiguous acceptance becomes Uncertain,
requiring reconciliation/user action instead of blind automatic retransmission.
Sent-folder append failure must never resend an accepted SMTP submission.

## Highest-risk decisions: prove early

1. GPUI: pin a tested revision/version and Rust toolchain; compile and run on all
   three OS families. Verify text entry, IME, clipboard, focus, scrolling,
   keyboard navigation, scaling, accessibility and window lifecycle.
2. HTML mail: GPUI is not a browser engine. Spike an isolated native webview
   within a GPUI reader on every platform, including focus, clipping and DPI.
   Disable JavaScript, navigation, downloads and network by default; sanitize
   HTML and mediate CID images/attachments through restricted resource access.
   Remote images require explicit policy. If integration is infeasible, document
   the fidelity tradeoff before choosing a restricted native renderer. Plain text
   alone is a milestone, not full parity. Never promise full HTML/CSS in GPUI.
3. Rust protocol libraries: evaluate maintained IMAP/SMTP/MIME candidates against
   real server fixtures before selecting and pinning. Test TLS/STARTTLS,
   capabilities, IDLE, UIDVALIDITY, MODSEQ, MOVE/COPYUID and Gmail threading.
4. Secrets: prove macOS Keychain, Windows credential protection, Linux Secret
   Service. Locked/missing vaults must surface actionable errors; no plaintext
   fallback. Inspect provider size limits and account-update atomicity.

## Milestones and acceptance gates

### M0 — Baseline and development foundation

- [ ] Inventory every LiameApi operation, command and preference in a parity matrix.
- [ ] Run existing install/typecheck/tests/build and record baseline failures.
- [ ] Add Rust workspace, pinned toolchain, formatting/lint/test commands.
- [ ] Add native CI checks without disrupting existing Electron checks/releases.
- [ ] Define platform/CPU/minimum OS support from actual dependency probes;
      initial candidates: Windows x64, macOS arm64/x64, Linux x64.
- [ ] Compile and launch a minimal GPUI window with packaged fonts/assets.

Gate: reproducible clean build and visible native window; all claimed platform
rows have real execution evidence, not only cross-compilation.

### M1 — Feasibility and native shell

- [ ] Resolve the four risk spikes above, recording decisions and limitations.
- [ ] Implement theme/density/zoom tokens, sidebar/list/reader layout and focus.
- [ ] Implement command registry, platform modifier display, palette and rebindings.
- [ ] Prove virtualized large lists and cancellation when selection changes.
- [ ] Verify screen-reader labeling, tab order, IME and high-DPI input.

Gate: synthetic fixture mail is navigable without network on each OS; reader
strategy and accessibility gaps are explicitly resolved or release-blocking.

### M2 — Local storage and secure accounts

- [ ] Implement versioned SQLite schema, migrations, indexes, FTS and transactions.
- [ ] Add credential-vault adapters and redacted public account models.
- [ ] Implement mailbox-generation isolation, cached MIME/body retention,
      pagination with deterministic tie ordering, conversations and unified inbox.
- [ ] Implement settings, contacts/snippets, attachment staging and cleanup.
- [ ] Test migration rollback, corrupt stores, disk-full errors and account removal.

Gate: persistent offline browsing/search after restart; no credentials in logs,
ordinary database account rows, UI snapshots or fixtures.

### M3 — Real IMAP synchronization and reading

- [ ] Implement setup/test/save/edit/remove accounts and provider presets.
- [ ] Implement folder discovery/special-use, initial paging, backfill and IDLE.
- [ ] Handle reconnect/backoff, sleep/wake, cancellation, expunge and capability fallbacks.
- [ ] Implement flags, move/archive/trash, permanent-delete confirmation and undo
      only when returned UID mapping makes undo safe.
- [ ] Implement MIME parsing, text/HTML reader, CID content and attachment saving.
- [ ] Implement local and server search with clear scope and offline behavior.

Gate: synthetic GreenMail integration plus a second differing server capability
fixture; tests cover reused UIDs, changed UIDVALIDITY and stale mark-read requests.
Never use real accounts/mail in captures or committed fixtures.

### M4 — Compose and delivery

- [ ] Implement recipient entry/completion, reply/all/forward and threading headers.
- [ ] Implement drafts/autosave, retained attachments, signatures and snippets.
- [ ] Implement TLS SMTP, recipient failures, Sent append and draft replacement.
- [ ] Persist outbox payloads/attachment snapshots and explicit delivery states.
- [ ] Test restart/disconnect before, during and after SMTP acceptance.

Gate: end-to-end receive/reply with captured MIME verification; no silent draft
loss, no duplicate sends caused by automatic ambiguous-result retries.

### M5 — Scheduling and feature parity

- [ ] Implement snooze/restore, scheduled sends, follow-up detection and cancellation.
- [ ] Define closed-app behavior honestly: jobs run when the application runs;
      reconcile overdue work on startup unless a separately tested OS agent exists.
- [ ] Implement optional AI compose/reply/rewrite/chat/brief, streaming and cancel.
- [ ] Implement labels and provider-key handling, preserving opt-in data policy.
- [ ] Verify every parity-matrix row, including bulk actions and mark-read policy.

Gate: deterministic clock/restart tests; optional providers disabled leave ordinary
mail functional and produce no provider traffic.

### M6 — Migration and operating-system integration

- [ ] Build a versioned, validated import path for cache/settings/contacts/drafts/jobs.
- [ ] Back up sources; never mutate the original Electron profile during import.
- [ ] Electron safeStorage blobs are not portable Rust credentials: prefer
      reauthentication; any same-machine exporter must avoid plaintext secret files.
- [ ] Ensure only one app can execute migrated queued sends; import sends paused
      for review to avoid both old and new clients submitting them.
- [ ] Implement dialogs, menus, notifications/click routing, mailto links,
      single-instance behavior, safe external URLs and application data paths.
- [ ] Test Windows path/ACL rules, macOS lifecycle and Linux desktop differences.

Gate: synthetic legacy-profile import with rollback and no duplicate scheduled
delivery; native integration exercised on all supported desktop environments.

### M7 — Packaging, hardening and cutover

- [ ] Produce platform-native packages with icons, runtime dependencies and metadata.
- [ ] Define signing/notarization and update policy; verify signature/update trust
      before claiming signed distribution or automatic updates.
- [ ] Test clean-machine install, upgrade, uninstall and profile retention.
- [ ] Audit untrusted HTML/MIME, attachment paths, resource limits, TLS validation,
      secret redaction, dependency licenses and AI subprocess argument handling.
- [ ] Measure startup, memory, scrolling and large-mailbox search on documented
      hardware; choose and record budgets from baseline rather than inventing wins.
- [ ] Run parity audit and platform smoke matrix; fix all release-blocking gaps.
- [ ] Switch default development/release commands to native app, then remove
      Electron/React/Node dependencies, preload and obsolete packaging.
- [ ] Update README, contributing, security policy and AGENTS instructions.

Gate: every parity row passes or has an explicitly agreed scope change; Windows,
macOS and Linux X11/Wayland packages run successfully. A build-only result does
not prove runtime support. Never mark this goal complete with missing evidence.

## Verification and commit discipline

Legacy baseline: `bun install --frozen-lockfile`, `bun run typecheck`,
`bun test ./tests`, `bun run build`. Retain these until native cutover.

Native gates: `cargo fmt --all -- --check`, `cargo check --workspace --locked`,
`cargo clippy --workspace --all-targets --locked -- -D warnings`,
`cargo test --workspace --locked`, and release package builds on native runners.
Use meaningful behavior tests per vertical slice, real SQLite and synthetic
protocol servers. Test parsers with malformed/oversized MIME and hostile HTML.
Use GPUI input tests where supported plus actual OS smoke tests; screenshots
alone do not prove input, accessibility, synchronization or delivery behavior.

Suggested commit units: plan; core identity invariants; workspace/CI; GPUI shell;
storage schema; vault adapters; offline list; account setup; initial sync; flags;
reader; composer; SMTP; outbox recovery; scheduling; AI; importer; each platform's
packaging; parity fixes; final cutover. Split further when verification is clearer.
Each commit should compile and pass its applicable checks; record any inherited
failure accurately. Update milestone checkboxes only when evidence exists.

## Current evidence and open decisions

- Repository inspected: Electron 45 / React 19 / Bun; macOS arm64-only packaging.
- GPUI upstream documents macOS, Linux X11/Wayland and Windows backends, but is
  pre-1.0 with breaking changes: pin dependencies and validate actual builds.
  Source: https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md
- Open: exact OS floors, additional CPU targets, HTML integration choice,
  protocol-library selections, OAuth scope, signing identities and update channel.
- OAuth is not existing parity (current setup uses passwords); evaluate provider
  requirements separately and document supported authentication accurately.
- No platform execution, baseline verification or migration completion claimed yet.
