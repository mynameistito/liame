# Changelog

All notable changes to Liame are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Liame follows
[Semantic Versioning](https://semver.org). Releases are cut from `main` by
bumping the version in `package.json`; the full per-release notes live on
[GitHub Releases](https://github.com/pcstyle-os/liame/releases).

## [Unreleased]

## [0.2.1] - 2026-11-05

### Fixed

- Settings saves show a spinner while they are in flight

## [0.2.0] - 2026-11-05

### Changed

- A broad calm-and-align pass over the mail UI: balanced reader layout,
  steadier empty states, and visible bulk actions under an empty filter
- Focused-row previews and search states meet contrast and labeling
  expectations (named switches, selects, and accent swatches)

### Fixed

- Faster, safer local cache behavior around UIDVALIDITY changes, bulk
  actions, and conversation paging

## [0.1.0] - 2026-10-30

### Added

- First release: an OLED-dark, keyboard-first mail client for macOS
- Gmail, Zoho, and generic IMAP accounts, with multiple accounts and an
  All Inboxes merged view
- Local cache for instant lists, cross-folder search, and offline reading
- Conversations that include your replies from Sent
- Snooze, send later, and follow-up reminders
- Command palette and rebindable shortcuts
- Optional AI drafting, summaries, daily brief, and automatic labels
- Keychain-encrypted account storage; signed builds that keep Keychain
  access across updates

[Unreleased]: https://github.com/pcstyle-os/liame/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/pcstyle-os/liame/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/pcstyle-os/liame/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pcstyle-os/liame/releases/tag/v0.1.0
