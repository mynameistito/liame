# Security Policy

## Supported versions

Only the [latest release](https://github.com/pcstyle-os/liame/releases/latest)
is supported. Liame updates by replacing the app bundle, and fixes ship in
the next release rather than as backports.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/pcstyle-os/liame/security/advisories/new)
for this repository. If that is unavailable to you, open a regular issue
saying only that you have a security report and how to reach you — do not
include details in the public issue.

Please include, as far as you can:

- The version of Liame and macOS you tested on
- What an attacker needs (a malicious email, a compromised server, local
  access, …) and what they gain
- Steps to reproduce, with synthetic mail only

You can expect an acknowledgement within a week. Please give the maintainer
a reasonable window to ship a fix before disclosing publicly.

## How Liame handles your data

Understanding the trust model helps target reports:

- **No backend.** Liame connects directly from your Mac to the IMAP/SMTP
  servers you configure. Optional AI features connect to the provider you
  configure (a local Codex CLI, OpenAI, or TypeSafe). There is no telemetry.
- **Credentials.** Account passwords and API keys are encrypted with
  Electron `safeStorage` (macOS Keychain) into `accounts.bin` /
  `settings.bin` under the app's user-data directory, written with mode
  `0600`. Passwords never leave the main process; the renderer only ever
  sees whether a key is set.
- **Local cache.** Message headers and recent bodies are cached in a local
  SQLite database (`mail.db`) in the same directory so the app works
  offline. It is protected by your macOS user account, not additionally
  encrypted — anyone with your unlocked Mac and user session can read your
  mail, as with most desktop mail clients. Use FileVault and a screen lock.
- **Renderer isolation.** The renderer runs sandboxed with context
  isolation and reaches the main process only through the typed
  `window.liame` preload bridge. Message HTML renders in a sandboxed
  frame; navigations and link clicks are restricted to `http(s):` and
  `mailto:` URLs and open in the default browser.
- **AI data flow.** Assistant actions send the message or conversation you
  invoked them on (body text truncated) to your chosen provider. Label
  classification sends sender, subject, and preview only, and only when
  you have selected an engine and supplied its key. Nothing is sent to an
  AI provider by default on install.

Out of scope: attacks that require an already-compromised macOS user
account, a malicious mail server you chose to configure, or social
engineering of app-password creation in your provider's settings.
