# Vaulterm on iOS & Android — porting roadmap

Vaulterm is a Tauri 2 app, and Tauri 2 supports iOS/Android. The app logic already
lives in a `cdylib`/`staticlib` lib (`src-tauri/Cargo.toml`) with a
`#[cfg_attr(mobile, tauri::mobile_entry_point)]` entry, so the scaffolding was
always mobile-ready. This doc tracks what's done and what's left.

## TL;DR

- **Android** is fully buildable from the current **Windows** dev machine — the
  SDK, NDK (27/28/29), and JDK 17 are installed and the Rust Android targets are
  present. Phase 1 (below) is done: the mobile build compiles and the Android
  project is scaffolded.
- **iOS cannot be built on Windows.** It needs macOS + Xcode + an Apple Developer
  account ($99/yr). Wire it as a Mac / CI (GitHub Actions `macos-14`) track later.
- The backend ports cleanly. The **big remaining work is the UI**: the desktop
  layout (fixed 280px sidebar, hover-only buttons, hardware-keyboard shortcuts,
  no on-screen terminal keys) is unusable on a phone as-is.

## Phase 1 — make the mobile build compile & run  ✅ DONE

- Moved `tauri-plugin-updater` + `tauri-plugin-process` to a desktop-only Cargo
  target table (they don't build for iOS/Android; stores handle updates).
- Gated their plugin registration behind `#[cfg(desktop)]` in `lib.rs`.
- Split `capabilities/` into `default.json` (cross-platform: core, event, dialog)
  and `desktop.json` (`platforms: [linux, macOS, windows]`: window control,
  file-save/open dialogs, updater, process) so desktop-only permissions no longer
  break mobile capability resolution.
- Made the vault path mobile-aware: desktop still uses `directories::ProjectDirs`
  (existing vaults stay put); mobile resolves the app-sandbox dir via Tauri's
  `app.path().app_config_dir()` in the `lib.rs` setup hook (`vault::set_base_dir`).
- Added `bundle.android.minSdkVersion` (26) and `bundle.iOS.minimumSystemVersion`
  (14.0) to `tauri.conf.json`.
- Ran `tauri android init` → generated `src-tauri/gen/android` (Gradle project;
  `AndroidManifest.xml` already has `android.permission.INTERNET` for SSH).

Desktop build re-verified with `cargo check` after all gating.

## Phase 2 — make it usable on a phone  ⬜ TODO (the big one)

Frontend only, but large. None of this breaks desktop; gate with a
`@media (max-width: 640px)` breakpoint + `@tauri-apps/plugin-os` `platform()`.

- **Responsive drawer layout.** `#app` is `grid-template-columns: 280px 1fr` with
  zero width media queries. Collapse to one column; turn the sidebar into an
  off-canvas drawer with a hamburger in the topbar; auto-close it when a session
  opens so the terminal is full-screen.
- **On-screen key toolbar** (the make-or-break item). Soft keyboards have no Esc,
  Tab, Ctrl, arrows, or `| / ~ -`. Add a scrollable accessory bar that sends raw
  bytes through the existing `api.sshWrite` path: Esc=`\x1b`, Tab=`\t`,
  Ctrl+C=`\x03`, arrows=`\x1b[A/B/C/D`, and a sticky Ctrl toggle
  (`char & 0x1f`).
- **Virtual-keyboard handling.** Focus the terminal inside a touch gesture (iOS
  won't raise the keyboard on programmatic focus); listen to
  `window.visualViewport` resize and refit + pad so the prompt stays above the
  keyboard.
- **Touch affordances.** Wrap hover rules in `@media (hover:hover)` (fixes sticky
  hover + makes the hover-only connection/file action buttons always visible on
  touch); bump tap targets to 44px; replace `window.prompt()` (dead in Android
  WebView) and `confirm()` with in-app modals/sheets.
- **Polish.** `viewport-fit=cover` + `env(safe-area-inset-*)` on the FAB, toasts,
  banner, topbar; full-screen bottom-sheet modals; single-column Files view;
  hide split-pane UI (clamp to 1 pane); pinch-to-zoom font; momentum scroll.

## Phase 3 — mobile feature decisions & store prep  ⬜ TODO

Decisions (recommended default in **bold**):

- **MCP server** — **desktop-only.** No AI client on a phone; iOS kills background
  sockets. `#[cfg(desktop)]`-gate the `mcp` module + `mcp_*` commands + settings
  UI (compiles on mobile today but is dead weight/attack surface).
- **Key-file auth** — **paste-key / password only on mobile.** No `~/.ssh`; the
  file path arm fails. Steer the UI to `KeyText` + password.
- **Port-forward tunnels** — **hide on mobile** except maybe a `-D` SOCKS proxy;
  `-L/-R` are marginal/nonsensical on a phone.
- **SFTP upload/download & vault backup** — rework the path-based flows to the
  mobile file picker / share sheet (they pass raw FS paths today).
- **Split panes** — off on mobile; tabs are the only multiplexing.

Store prep:

- **Google Play:** generate an upload keystore (`keytool …`), wire signing in
  `gen/android`, target the current required API level, complete the Data-safety
  form (SSH creds stored on-device, encrypted, not shared). Build with
  `tauri android build --aab`.
- **Apple:** set `ITSAppUsesNonExemptEncryption` in Info.plist (AES/SSH generally
  qualify for the standard-crypto exemption) to skip the per-upload prompt; keep
  the year-end BIS self-report in mind.

## Phase 4 — iOS  ⬜ TODO (needs a Mac)

On a Mac (or `macos-14` CI runner): install Xcode + command-line tools;
`rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`;
enroll in the Apple Developer Program; `pnpm tauri ios init`;
set `bundle.iOS.developmentTeam` (or `TAURI_APPLE_DEVELOPMENT_TEAM`);
`pnpm tauri ios build`.

## Android quick-start (this Windows machine)

Env vars are already persisted via `setx` (restart the terminal to pick them up):

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME     = "$env:LOCALAPPDATA\Android\Sdk\ndk\27.1.12297006"
$env:JAVA_HOME    = "C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot"
```

```powershell
# already run once: pnpm tauri android init   (generated src-tauri/gen/android)

pnpm tauri android dev                       # run on an emulator / attached device (needs --host for HMR)
pnpm tauri android build --debug --apk --target aarch64   # quick single-ABI debug APK
pnpm tauri android build --aab               # release bundle for Play (needs signing)
```

> Do **not** commit signing keystores or `gen/android/.../*.jks`. See the repo's
> git-add caution — never `git add -A` here.
