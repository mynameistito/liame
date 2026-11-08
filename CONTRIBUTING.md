# Contributing to Liame

Thanks for helping make Liame better. This document covers the development
setup, what CI checks, and the conventions the codebase already follows.

## Development setup

Liame is an Electron app: React renderer, IMAP via imapflow, packaged with
electron-builder. [Bun](https://bun.sh) is the package manager and test
runner — use the version CI pins (1.4.0).

```sh
bun install --frozen-lockfile
```

| Command | What it does |
| --- | --- |
| `bun run dev` | Run the app in development (macOS) |
| `bun run typecheck` | `tsc --noEmit` over the whole project |
| `bun test ./tests` | Run the test suite |
| `bun run build` | Bundle main, preload, and renderer into `out/` |
| `bun run dist` | Build and package `dist/mac-arm64/Liame.app` (macOS, Apple silicon) |

Typecheck, tests, and `bun run build` also run on Linux. Running and
packaging the app needs macOS: account storage is backed by the macOS
Keychain (`safeStorage`), and the window uses the `hiddenInset` title bar.
Packaged builds are signed with the first identity from
`scripts/sign-identity.sh`, falling back to an ad hoc signature.

You do not need a real mailbox to work on the mail engine: point the app at
a local test server such as [GreenMail](https://greenmail-mail-test.github.io/greenmail/)
(IMAPS/SMTPS) and seed it with synthetic messages. Never use real accounts
or real mail in tests, fixtures, or screenshots.

## Before you open a pull request

CI (`.github/workflows/build.yml`) runs, on every pull request:

1. `bun install --frozen-lockfile`
2. `bun run typecheck`
3. `bun test ./tests`
4. `bun run build`

…and then builds and signature-checks the macOS app. Run the first four
locally before pushing; it is much faster than finding out from CI.

Please also:

- **Add a test when behavior changes.** Tests live in `tests/` and run with
  `bun:test`. A bug fix should come with a regression test that fails
  without the fix; assert observable behavior through the public interface,
  not internals.
- **Keep changes scoped.** One pull request, one concern. If you spot an
  unrelated problem, open an issue for it instead of bundling a fix.
- **Match the code around you.** Single quotes, no semicolons, two-space
  indent, strict TypeScript (`noUnusedLocals` is on). Types shared between
  processes belong in `src/shared/types.ts` — it is the single contract for
  the main/preload/renderer boundary.
- **Write commit subjects in the imperative**, like the existing history
  ("Keep the palette fade off the snooze list"), and say *why* in the body
  when the change is not self-evident.

## Reporting bugs and suggesting features

Use the issue templates. For bugs, the most useful reports include what you
did, what you expected, what happened, your macOS version, and your provider
(Gmail / Zoho / other IMAP — redact addresses and never paste passwords or
message contents you would not post publicly).

For security vulnerabilities, do **not** open a public issue. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers the project.
