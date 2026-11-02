---
trigger: always_on
description: Architecture, change-impact map, and verification commands for Termkin.
---

# Termkin project memory

This file is a navigation guide. Confirm details against current source before editing and update this guide when architecture or commands change.

## Product and stack

- Termkin is a desktop SSH terminal with an encrypted connection vault, terminal tabs, SFTP file browsing/editing, SSH tunnels, snippets, and a local MCP server for scripts and AI agents.
- Frontend: vanilla TypeScript with strict compiler checks, Vite, xterm.js, and CodeMirror. This project does not use React, Vue, or a web backend framework.
- Backend: Tauri 2 and Rust, with Tokio, russh, russh-sftp, and Axum for the local MCP endpoint.
- Keep the existing internal crate/bundle identity `vaulterm` / `com.codework.vaulterm` compatible with saved user data.
- Follow the existing Tauri architecture for this application's mobile support; do not replace it with a native Java implementation unless explicitly requested.

## Entry points and change-impact map

- `index.html`, `src/main.ts`, and `src/styles.css`: app structure, initialization, and styling.
- `src/api.ts`: typed frontend Tauri invocation wrappers, DTOs, and event/channel contracts.
- `src-tauri/src/commands.rs`: Tauri command handlers; `src-tauri/src/lib.rs`: registered commands, shared AppState, and lifecycle cleanup.
- IPC changes: update frontend wrappers and consumers, Rust handler signatures/data types, and command registration together where affected. Verify event names and argument casing.
- `src/terminal.ts` and `src-tauri/src/ssh.rs`: terminal sessions and SSH lifecycle; output uses base64 through a Tauri channel.
- `src/connections.ts`, `src-tauri/src/store.rs`, `src-tauri/src/vault.rs`, and `src-tauri/src/vault_pb.rs`: connection data, encrypted persistence, and protobuf codecs. Check legacy migration paths before changing serialized data.
- `src/files.ts`, `src/editor.ts`, and `src-tauri/src/sftp.rs`: remote file browsing, editing, transfer, and concurrent-save handling.
- `src/tunnels.ts` and `src-tauri/src/tunnel.rs`: port forwarding and teardown.
- `src-tauri/src/mcp.rs`: authenticated loopback MCP server, tool schemas, execution limits, and approval requests.
- `cli/termkin.mjs`: Node CLI entry point; `cli/core.mjs`: argument parsing, config, JSON results, and MCP transport; `cli/test/cli.test.mjs`: CLI tests.
- MCP or CLI changes: inspect server tool schemas and response shapes, CLI mappings, tests, and `docs/CLI.md` together.
- `README.md`, `docs/CLI.md`, `MOBILE.md`, and `RELEASING.md`: product usage, CLI behavior, platform setup, and release instructions.

## Invariants and relevant edge cases

- Preserve vault encryption (Argon2id plus AES-256-GCM), locked-vault gating, and key cleanup. Never expose master passwords, SSH secrets, tokens, or decrypted vault data in logs or committed files.
- Preserve SSH host-key verification: first-use trust and changed-key rejection/review. Do not silently bypass verification.
- Preserve SFTP concurrent-save protection and session/tunnel/server cleanup when locking or exiting.
- Keep the MCP server on loopback and preserve bearer authentication and desktop approval for remote command execution/file writes.
- CLI credentials come from configured sources such as `TERMKIN_TOKEN`, a token file, or CLI config. Preserve redaction and JSON output contracts.
- Check locked vaults, disconnects/timeouts, invalid or ambiguous connection names, oversized output, and permission rejection when relevant.
- Read `git status` and the existing diff before editing; preserve the user's unrelated work. Avoid changing generated `dist/`, `node_modules/`, or `src-tauri/target/` files by hand.

## Verification

Run checks appropriate to the edited layers and report actual results, including existing failures:

- Frontend: `npm run typecheck` and `npm run build` (or the equivalent pnpm commands). `build` runs Vite and does not replace the separate TypeScript check.
- CLI: `npm run test:cli`; requires Node.js 22 or newer. Offline discovery: `node cli/termkin.mjs --help` and `node cli/termkin.mjs schema`.
- Rust: `cargo check --manifest-path src-tauri/Cargo.toml`; for backend behavior, `cargo test --manifest-path src-tauri/Cargo.toml`. SSH execution tests are in `src-tauri/src/ssh_exec_tests.rs`.
- Desktop development: `pnpm tauri dev`; release installer build: `pnpm tauri build`. Windows Rust builds need the MSVC toolchain, C++ Build Tools/SDK, and WebView2.
- There is no `lint` script in the current `package.json`; do not claim to have run it.

<!-- BEGIN ANTIGRAVITY WORKFLOW -->

## Default workflow

- Treat short natural-language coding requests as actionable work. Infer acceptance criteria from the request and current source, and use the global `ship-feature` skill automatically.
- Follow discovery, impact analysis, implementation, verification, review, and repair without requiring the user to repeat a checklist or say continue.
- For UI work, use available browser/desktop tools to verify real interactions, and distinguish UI results from build/test results. Confirm the actual running URL; desktop application coverage requires a desktop automation tool.
- Keep engineering repair loops within the skill's shared budget and report remaining blockers truthfully.
- Recheck this memory against current source and update it when architecture or verification commands change.

<!-- END ANTIGRAVITY WORKFLOW -->
