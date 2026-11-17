# AGENTS.md

Tiro desktop: Jamie's Windows assistant app, part of Tiro (server: github.com/cijamie/tiro, tiro.jamies.dev).
A Tauri 2 shell in Rust (`app/tauri/src-tauri`), a Node sidecar that runs the agent (`app/tauri/sidecar`), shared
browser JS for the overlay (`app/overlay`), the panel (`app/panel`) and the setup guide (`app/onboarding`), and two
Windows helpers built by `build.sh`: voice (`src-tauri/voice-win`, Rust + Parakeet; `--transcribe <wav>` and
`--test-audio <wav>` test speech, see the top of its `main.rs`) and hands (`src-tauri/hands-win`: windows,
capture, UI Automation and OCR). Only hands-win's `logic.rs` builds off Windows, so `cargo test` there runs its
checks anywhere; `tiro-hands --smoke` drives Notepad on a real Windows desktop (CI).

Windows only since the split from Roamies (2026-11-17). Some JS still has inert `MAC`/`LINUX` branches; remove them
when touching that code. The Cargo manifests keep their macOS/Linux dependency sections so `--locked` builds match
Cargo.lock; prune them together with a lockfile update.

Data: `~/.tiro` (`sidekick.json` settings, `sidekick/` memory, sessions, logs, DPAPI-encrypted voice keys),
`~/.gg/auth.json` (sign-in, owned by the gg framework), `~/Tiro` (background agents' files), `%LOCALAPPDATA%\Tiro`
(speech model). `app/tauri/sidecar/paths.mjs` defines them and moves the Roamies-era copies on first start.

## Commands

```sh
cd app/tauri/sidecar && npm ci     # install sidecar deps
npm test                           # sidecar tests
npm run build                      # bundle the sidecar into dist/
cd .. && ./build.sh dev            # web files + sidecar + helpers + debug `cargo build` (Windows)
./build.sh release --target x86_64-pc-windows-msvc   # the installer
```

## Shipping

`.github/workflows/tiro-windows.yml` runs on every push: sidecar tests, the build, the shell's and helpers' tests and
the Notepad smoke test. A push to `main` also publishes release v0.2.<run number> with a signed `latest.json`, and
every installed copy updates itself from it. So work on a branch and merge to `main` only when CI is green and Jamie
is fine with it shipping.

## Rules

- Every tool that touches files, commands, URLs or other apps goes through `app/tauri/sidecar/safety.mjs`
  (tested in `test/safety.test.mjs`); the hands helper also refuses to type or click in the apps in `HANDS_OFF`
  (`hands-win/src/logic.rs`). Add a test case with every rule change.
- In-app updates read `latest.json` from the newest release, signed with the `TAURI_SIGNING_PRIVATE_KEY` secret;
  the workflow writes `plugins.updater.pubkey` from `TAURI_UPDATER_PUBKEY`.
- Never commit with `--no-verify`, experiments, or secrets (`~/.gg/auth.json`, signing keys).
- Keep the AGPL notice: LICENSE, credit to Roamies by Ken Kai in the README, the About page and THIRD_PARTY_NOTICES.
