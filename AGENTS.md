# Liame

Electron mail client for macOS (React renderer, IMAP via imapflow). Bun is the package manager and test runner.

## Commands

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test ./tests`
- `bun run build`: bundles main, preload and renderer into `out/`
- `bun run dist`: builds and packages `dist/mac-arm64/Liame.app` (macOS only)

CI (`.github/workflows/build.yml`) runs the first four on Linux and `bun run dist` on macOS. A push to `main` releases the version in `package.json` once, so bump it to cut the next release.

## Amp orbs

`.agents/setup` installs the Bun version CI pins, dependencies, and the Electron binary, so fresh orbs start ready. Typecheck, tests, and builds run on the orb. The app itself is macOS-only (Keychain-backed account storage, `hiddenInset` title bar, native dialogs), so run, package, and screenshot it on a Mac satellite instead.

## Mac satellite

Start one with `mac_sidecar` (`action: start`). It mirrors this worktree to `~/workspace/repo` on the Mac; edit files on the orb and the next `mac_shell` call syncs them. The mirror skips `.amp/`, so copy scratch files to the Mac with `mac_write_file`, or serve them from the orb and add the port with `forward_ports`.

One-time preparation on a new Mac:

```sh
curl -fsSL https://bun.sh/install | bash -s bun-v1.4.0   # same version as CI
export PATH=$HOME/.bun/bin:$PATH
bun install --frozen-lockfile
node node_modules/electron/install.js                    # bun can skip Electron's postinstall
```

Build and check the packaged app the way CI does:

```sh
bun run dist
codesign --verify --deep --strict dist/mac-arm64/Liame.app
```

Without a signing identity on the Mac, `scripts/sign-identity.sh` falls back to an ad hoc signature, which is fine for testing.

### Running the app with mail

Saving an account encrypts it with Electron `safeStorage`, which needs an unlocked Keychain. The satellite's login keychain is locked, so `saveAccount` fails with "Error while encrypting the text". Make a throwaway keychain the default first:

```sh
k=~/Library/Keychains/liame-test.keychain-db
[ -f $k ] || security create-keychain -p liame $k
security unlock-keychain -p liame $k
security set-keychain-settings $k
security default-keychain -s $k
security list-keychains -d user -s $k
```

For realistic mail, run a local [GreenMail](https://greenmail-mail-test.github.io/greenmail/) server (`brew install openjdk@21`, then the `greenmail-standalone` jar from Maven Central) with IMAPS on 3993 and SMTPS on 3465, and seed it with synthetic messages over IMAP (`imapflow` `append`). Drive the app with Playwright's `_electron`:

- Launch `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` with the repo root and a throwaway `--user-data-dir`, so no real profile or account is touched.
- Set `LIAME_BACKGROUND=1` so the window never shows or takes focus, and `NODE_TLS_REJECT_UNAUTHORIZED=0` for GreenMail's self-signed certificate.
- Add the fixture account by calling `window.liame.saveAccount(...)` from the page with `provider: 'imap'` and the GreenMail ports, then reload.
- Pass `--force-device-scale-factor=2` and use `page.screenshot` for Retina captures, or `screencapture -x` for the whole screen including the title bar.

Never use real accounts or real mail in captures.
