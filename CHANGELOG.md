# Changelog

## 1.7.3-sandbox.1 - 2026-07-18

### Added

- **Native macOS sandboxing for Grok sessions, carried forward onto upstream v1.7.2.** The extension applies Grok-compatible Seatbelt protection to the complete session: the selected profile is passed to Grok's own process-lifetime sandbox and mirrored for delegated ACP filesystem operations, terminal commands, and their descendants.
  - **Built-in profiles:** `workspace` can write the project, all of `$GROK_HOME`, and trusted temporary storage; `devbox` can write existing top-level trees except `/data` and virtual filesystems; `read-only` can write only `$GROK_HOME` and temporary storage; and `strict` additionally limits reads to the project and essential runtime paths. As in Grok itself, child-network restriction is a no-op on macOS.
  - **Grok-spec profile loading:** built-in and custom profiles are discovered and resolved according to Grok's own sandbox specification. Custom definitions load from `$GROK_HOME/sandbox.toml` or project `.grok/sandbox.toml`, derive directly from `workspace`, `devbox`, `read-only`, or `strict`, and support additional read-only paths, writable paths, network intent, and kernel-enforced exact or glob denies. Project definitions replace same-name user definitions, built-in names remain reserved, profile names are case-sensitive, and only exact lowercase `off` disables sandboxing.
  - **Session behavior:** the chosen profile is fixed for the life of a conversation and restored when that conversation resumes. Built-in application failures warn and continue like Grok; invalid or unapplied custom profiles refuse to start; and loss of the live delegated-operation sandbox ends the affected session instead of silently weakening it.
  - **Sandbox controls:** supported macOS hosts get a sandbox picker with distinct icons and source labels for built-in, user-defined, and workspace-defined profiles. The control stays disabled from session startup through the full active turn, in lockstep with Agent Mode, and changing the profile of an existing conversation opens the Summarize or Just Restart flow required to start a new session under the new boundary.
  - See the [macOS sandbox architecture guide](docs/macos-sandbox-architecture.md) for the full access matrix, profile resolution rules, process topology, and enforcement boundary.

## 1.7.2 — 2026-07-18

### Fixed

- **Hitting your usage/weekly limit no longer looks like a sign-in problem.** A rate-limited turn (ACP error `-32003`, or the CLI's limit phrasings) now shows a clear "Usage limit reached — not a sign-in issue" notice carrying the CLI's own message. Before, the limit's billing-flavored wording tripped the expired-token recovery, whose retry ended on the login screen. No reset date is shown because the CLI/backend never provides one. ([#57](https://github.com/phuryn/grok-build-vscode/issues/57); [src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts))

## 1.7.1 — 2026-07-18

### Changed

- **README reworked as a landing page.** Features now sit directly under *Why use this?*, descriptions are trimmed to the point (deep technical detail stays in the dedicated docs), and the duplicate *Cost control* / *Context & cost* sections are merged into one. Fresh screenshots for **Context & cost**, **Fork conversation**, and **Queue or steer**, plus a new **Subagents** feature entry; the *Agent Dashboard* section folded into *Session history*, which now hosts the status-dot legend.
- **Smaller vsix** (~4 MB less): four unused screenshots removed and the `/imagine` hero image converted to WebP (2.9 MB → 240 KB).

## 1.7.0 — 2026-07-17

Three requested features, all built on ACP surfaces the Grok Build CLI already ships but never advertises — probe-confirmed against grok 0.2.101 first ([research/grok-build-oss-findings.md](research/grok-build-oss-findings.md) § 3a) and pinned by new real-grok gates.

### Added

- **Steer — redirect Grok mid-turn without interrupting it.** A message sent while Grok works still queues by default; now the pending message carries a **Steer** button that sends it straight into the running turn, so Grok changes course mid-answer. It is not a Stop: the turn keeps its in-flight tool work and finishes normally. **Steer by default** (gear → *Config & debug*, off by default) makes send-while-busy skip the queue entirely; steered text is plain text only (no chips, editor context, or `/commands`), and a CLI that can't steer falls back to queueing rather than losing the message. ([#52](https://github.com/phuryn/grok-build-vscode/issues/52); [src/acp.ts](src/acp.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))
- **Fork conversation** (gear → *Fork conversation*) — branch the conversation into a new session named `(Fork) <original>`, leaving the original byte-for-byte unchanged in your history. It branches the conversation, **not your code**: files on disk are untouched. ([#48](https://github.com/phuryn/grok-build-vscode/issues/48); [src/acp.ts](src/acp.ts), [src/sessions.ts](src/sessions.ts), [src/sidebar.ts](src/sidebar.ts))
- **Token usage in the context popover.** Click the donut for a **Session total** of what the conversation has billed (input / cache read / output), tracked across every turn, plus a collapsible **Last turn** with the same split and its **model calls** — the number that explains why a turn bills far more than the context it holds. Cache *read* is shown; no cache-*creation* figure exists anywhere in the CLI, so it is omitted rather than faked as zero. ([#53](https://github.com/phuryn/grok-build-vscode/issues/53); [src/acp-dispatch.ts](src/acp-dispatch.ts), [src/sidebar.ts](src/sidebar.ts), [media/chat.js](media/chat.js))

### Changed

- **Compact conversation moved from the gear menu to the context popover** — it is a context action, so it now sits next to the number that tells you when you need it (disabled at 0 tokens). The gear's Session section holds *Fork conversation*. ([media/chat.js](media/chat.js))
- **Usage telemetry adds three feature flags** (`showThinking` / `expandToolDetails` / `steerByDefault`) **and the host app** (VS Code / Cursor / …), so we can see whether our defaults are the ones people keep and which VS Code forks are worth supporting. Still anonymous, one event per session, no content — every field is listed in [docs/privacy.md](docs/privacy.md). ([src/telemetry.ts](src/telemetry.ts))

### Fixed

- **The buttons on a pending message no longer miss while Grok is streaming.** Steer / Edit / Remove act on press instead of click: the pending block sits at the end of the chat, which re-scrolls on every streamed chunk, so the button moved out from under the cursor mid-click. ([media/chat.js](media/chat.js))

---

Older releases (before 1.7.0): see [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).
