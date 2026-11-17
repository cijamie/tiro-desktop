# Tiro desktop

This is Jamie's Tiro desktop app: a fork of [Roamies](https://github.com/KenKaiii/Roamies) by Ken Kai, reskinned as
Tiro and connected to the Tiro server (tiro.jamies.dev, on the tailnet). Roamies is AGPL-3.0, and so is this fork
(see LICENSE); the changes below are listed so it's clear what differs from the original.

## What changed from Roamies

- **Name and look:** the app is called Tiro (`productName`, `identifier dev.jamies.tiro`), with Tiro's icon (cream T
  and smile on rust) and Tiro's rust-and-cream colours in the panel, setup guide, cards and the on-screen character.
- **Voice:** the classic look is now "Tiro" and speaks with JARVIS's Fish Audio voice (Gemini: Charon).
- **Personality:** a calm, capable, quietly witty assistant (JARVIS-style) instead of a cheeky companion.
- **Tiro tools** (`showcase/tauri/sidecar/tiro.mjs`, tested in `test/tiro.test.mjs`):
  - `tiro_ask`: asks the Tiro server (Gmail, Calendar, Drive, iCloud, Obsidian vault, Canvas, to-dos, memory).
    Calendar events are proposed and approved in the Tiro app.
  - `tiro_send_to_phone`: a push notification on the phone (long text and links are also saved to the vault Inbox).
  - `tiro_save`, `tiro_add_todo`, `tiro_remind`.
  - `read_selection`: copies the highlighted text in the app in front (never in a terminal) and restores the clipboard.
- **Sign-in to Tiro:** none needed. The server knows this computer by its Tailscale identity. `TIRO_URL` changes the
  address; `TIRO_TOKEN` (a personal token from Tiro's Settings) is a fallback.
- **Updates:** never from Roamies (that would replace Tiro). The updater points at this repo's releases, and update
  bundles are off until Tiro has its own signing key.
- **Builds:** `.github/workflows/tiro-windows.yml` builds the Windows installer on every push to `main` and puts it
  on the **Latest build** pre-release. Roamies' `ci.yml` and `release.yml` run only by hand.
