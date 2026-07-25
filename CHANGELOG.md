# Changelog

## 2.0.3-sandbox.1 - 2026-07-25

### Added

- **Native macOS sandboxing for Grok sessions, carried forward onto upstream v2.0.2.** The extension applies Grok-compatible Seatbelt protection to the complete session: the selected profile is passed to Grok's own process-lifetime sandbox and mirrored for delegated ACP filesystem operations, terminal commands, and their descendants.
  - **Built-in profiles:** `workspace` can write the project, all of `$GROK_HOME`, and trusted temporary storage; `devbox` can write existing top-level trees except `/data` and virtual filesystems; `read-only` can write only `$GROK_HOME` and temporary storage; and `strict` additionally limits reads to the project and essential runtime paths. As in Grok itself, child-network restriction is a no-op on macOS.
  - **Grok-spec profile loading:** built-in and custom profiles are discovered and resolved according to Grok's own sandbox specification. Custom definitions load from `$GROK_HOME/sandbox.toml` or project `.grok/sandbox.toml`, derive directly from `workspace`, `devbox`, `read-only`, or `strict`, and support additional read-only paths, writable paths, network intent, and kernel-enforced exact or glob denies. Project definitions replace same-name user definitions, built-in names remain reserved, profile names are case-sensitive, and only exact lowercase `off` disables sandboxing.
  - **Session behavior:** the chosen profile is fixed for the life of a conversation and restored when that conversation resumes. Built-in application failures warn and continue like Grok; invalid or unapplied custom profiles refuse to start; and loss of the live delegated-operation sandbox ends the affected session instead of silently weakening it.
  - **Sandbox controls:** supported macOS hosts get a compact lock/unlock indicator stacked between the voice and Send controls; profile names, distinct source icons, and source labels for built-in, user-defined, and workspace-defined profiles live in its picker. The sandbox control stays disabled from session startup through the full active turn because its boundary is fixed for the conversation, while Agent Mode remains available mid-turn; changing the profile of an existing conversation opens the Summarize or Just Restart flow required to start a new session under the new boundary.
  - See the [macOS sandbox architecture guide](docs/macos-sandbox-architecture.md) for the full access matrix, profile resolution rules, process topology, and enforcement boundary.

## 2.0.2 — 2026-07-25

### Fixed

- **Files missing from the composer's `@` autocomplete** in large workspaces ([#69](https://github.com/phuryn/grok-build-vscode/issues/69)). The file index was capped at 5000 entries, and past that cap VS Code returns an arbitrary subset — so real source files could be absent while less relevant ones still showed. Any file open as a tab is now always mentionable, and the new `grok.mentionIndexLimit` setting raises the cap for big repos. Thanks to [@datvm](https://github.com/datvm) for the diagnosis and the fix ([#70](https://github.com/phuryn/grok-build-vscode/pull/70)).

---

## 2.0.1 — 2026-07-25

### Added

- **Keep this machine awake while an [AFK Pilot](https://afkpilot.com) device is linked**, so a turn you started from your phone isn't cut off by idle sleep — `caffeinate` on macOS, `SetThreadExecutionState` on Windows, `systemd-inhibit` on Linux. Only system sleep is blocked (the display still sleeps), the lock is released the moment you sign out, and it never survives closing VS Code. Turn it off with `grok.remote.keepAwake`. A closed laptop lid still suspends on every OS.

---

## 2.0.0 — 2026-07-25

The extension pairs with **[AFK Pilot](https://afkpilot.com)** — a companion web client that brings your Grok sessions to your phone or any browser — and moves to a Fair Source license.

### Added

- **Remote control via [AFK Pilot](https://afkpilot.com)** — gear → *Remote Control* → **Sign in (link this device)** pairs this machine with the AFK Pilot web client: follow running turns, approve permissions, answer questions, and send or steer messages from a phone or any browser while away from your desk. The extension dials out to the service (no inbound port); **Sign out** unlinks the device here and revokes it on your account. The experimental `grok.remoteControl.relayUrl` setting is gone — pairing is one click now.
- **Touch-ready chat UI** — real tap targets on touch screens, always-visible actions on history rows / images / equations / diagrams (previously hover-only), roomier question and permission cards, and in-browser PNG download for generated images, math, and Mermaid diagrams. A resize (e.g. the mobile keyboard collapsing) no longer yanks the chat to the bottom.
- ` ```math ` / ` ```latex ` / ` ```tex ` code fences render as display equations, like ` ```mermaid ` already did for diagrams.

### Changed

- **License: MIT → FSL-1.1-MIT (Fair Source).** Free to use, modify, and redistribute for any purpose except a competing commercial product or service; each release automatically becomes plain **MIT two years after publication**. Versions up to and including 1.8.1 were published under MIT and remain MIT. ([LICENSE](LICENSE))
- **Destructive confirmations are now in-chat dialogs** (delete session, clear all history, apply/remove worktree, remote sign-out) instead of native VS Code modals, so they behave identically in the sidebar and the AFK Pilot browser client.
- Card titles render in the UI font instead of the editor's monospace.

---

Older releases (before 2.0.0): see [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).
