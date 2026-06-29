# Vaulterm

A small desktop **SSH terminal** that remembers your connections. Built with
**Tauri 2 + Rust** (backend) and **TypeScript + xterm.js** (frontend).

- 🔒 **Master-password vault** — set a password on first run; everything you
  save is encrypted at rest with **Argon2id + AES-256-GCM**. You unlock with the
  password each launch; nothing is readable without it (no recovery if forgotten)
- 📇 Save SSH connections (name, host, port, user, auth method)
- 🔑 Auth by **password**, **private-key file**, or **pasted key text** (OpenSSH/PEM)
  — all secrets live **inside the encrypted vault**, never in plaintext on disk
- ⚡ **Command palette** (`Ctrl+K`) with a built-in **Ubuntu** snippet pack
  (apt, systemd, ufw, journalctl, docker…) plus your own custom snippets;
  `{placeholder}` prompts; inserts into the terminal for you to review & run
- 📁 **Remote file browser + editor** over SFTP — browse directories, open a
  file in the built-in editor, and **save only after a confirmation prompt**
  (no accidental overwrites)
- 🖥️ Real interactive shell over SSH with a proper PTY (vim, htop, colors, resize)
- 🗂️ Multiple sessions in tabs
- 💾 Connection metadata persisted as JSON in your per-user config dir

## Tech

| Layer        | Choice                                                        |
| ------------ | ------------------------------------------------------------- |
| Shell        | [Tauri 2](https://v2.tauri.app)                               |
| SSH          | [`russh`](https://crates.io/crates/russh) 0.61 (`ring` backend) |
| Encryption   | [`argon2`](https://crates.io/crates/argon2) 0.5 (Argon2id) + [`aes-gcm`](https://crates.io/crates/aes-gcm) 0.10 (AES-256-GCM) |
| Terminal UI  | [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm) 6 |
| Frontend     | Vite + TypeScript (vanilla)                                   |

## Prerequisites

- **Node** + **pnpm** (`npm i -g pnpm`)
- **Rust** (stable, MSVC toolchain on Windows)
- **WebView2** runtime (ships with modern Windows / Edge)
- **Visual Studio Build Tools** with the *Desktop development with C++* workload
  (provides `cl.exe` + the Windows SDK — needed to compile the `ring` crypto crate)

## Run

```bash
pnpm install
pnpm tauri dev      # hot-reloading dev build
```

## Build a release installer

```bash
pnpm tauri build    # outputs to src-tauri/target/release/bundle/
```

## How it works

```
┌──────────────┐   invoke(ssh_open/write/resize/close)   ┌────────────────────┐
│ xterm.js     │ ──────────────────────────────────────► │ Tauri commands     │
│ (TypeScript) │ ◄────────── Channel<base64 bytes> ────── │ (Rust)             │
└──────────────┘            "ssh-closed" event            └─────────┬──────────┘
                                                                     │
                                              one tokio task per session
                                                                     │
                                                          ┌──────────▼──────────┐
                                                          │ russh PTY channel   │
                                                          │  ⇄ remote shell     │
                                                          └─────────────────────┘
```

- Each terminal tab gets a unique session id and its own background task that
  owns the russh channel. Keystrokes flow in over an mpsc channel; the remote
  PTY's bytes stream back to the webview over a Tauri `Channel<String>` as
  base64 (binary-safe — raw bytes are handed straight to xterm).
- All connections (with their secrets) and custom snippets are encrypted into a
  single `vault.json` under your local app-config dir. The key is derived from
  your master password with Argon2id; the JSON payload is sealed with
  AES-256-GCM. Secrets only exist decrypted in memory while unlocked.

## Source layout

```
index.html, src/        frontend (main.ts, terminal.ts, connections.ts, snippets.ts, api.ts)
src-tauri/src/
  lib.rs                Tauri builder + shared state
  commands.rs           #[tauri::command] bridge (vault-gated)
  vault.rs              Argon2id + AES-256-GCM encrypted vault
  store.rs              shared data types
  ssh.rs                russh connect/auth + per-session pump task
```

## Security notes

- **Master password has no recovery.** The vault key is derived from it; if you
  forget it, the encrypted data cannot be decrypted. The auth tag (AES-GCM) is
  what tells a wrong password from a right one — there is no stored hash to leak.
- Locking (🔒 / `Ctrl+L`) closes all live SSH sessions and zeroizes the key.
- **Host-key verification is trust-on-first-use accept-all** right now
  (`ssh.rs::check_server_key` returns `Ok(true)`). For untrusted networks you
  should compare against a `known_hosts` / TOFU store before accepting. This is
  the one deliberate shortcut — see the comment in `ssh.rs`.
