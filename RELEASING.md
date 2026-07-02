# Releasing a signed update

Vaulterm ships in-app auto-update (Settings → **Check for updates**). The app checks
`https://github.com/Temkung007/Vaulterm/releases/latest/download/latest.json`, downloads the
signed NSIS installer, verifies the signature against the public key baked into
`src-tauri/tauri.conf.json`, installs it, and relaunches.

## Signing keys

- **Private key:** `~/.tauri/vaulterm.key` — **secret, never commit it.** It currently has
  **no password**. To add one, regenerate and update the public key:
  `pnpm tauri signer generate -f -p "<password>" -w ~/.tauri/vaulterm.key`, then paste the new
  `~/.tauri/vaulterm.key.pub` contents into `plugins.updater.pubkey` in `tauri.conf.json`.
- **Public key:** already set in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
- If the private key (or its password) is lost, existing installs can no longer verify updates
  until you ship a new build with a new public key.

## Cut a release

1. Bump the version in all three, keeping them identical:
   `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.

2. Build with the signing key in the environment. **Use Git Bash, not PowerShell** —
   the key has no password, and PowerShell silently drops empty-string env vars
   (`$env:X = ""` unsets it), so Tauri never receives the empty password and hangs
   at a `Decrypting updater signing key, expect a prompt for password` prompt. Bash
   (and GitHub Actions) preserve empty env vars, so signing runs non-interactively:

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/vaulterm.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # empty — the key has no password
   npm run tauri build
   ```

   (Alternatively, give the key a password with `pnpm tauri signer generate -p …` so
   the env var is non-empty and any shell works — then update the pubkey in
   `tauri.conf.json`.)

   Produces, under `src-tauri/target/release/bundle/nsis/`:
   - `Vaulterm_<ver>_x64-setup.exe` — the installer the updater downloads
   - `Vaulterm_<ver>_x64-setup.exe.sig` — its signature

3. Build `latest.json` (the update manifest). `signature` is the **contents** of the `.sig` file:

   ```json
   {
     "version": "<ver>",
     "notes": "What changed in this release",
     "pub_date": "2026-07-01T00:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<paste the .sig file contents>",
         "url": "https://github.com/Temkung007/Vaulterm/releases/download/v<ver>/Vaulterm_<ver>_x64-setup.exe"
       }
     }
   }
   ```

4. Create a GitHub Release tagged `v<ver>` and upload **both** the `..._x64-setup.exe` and
   `latest.json`. The endpoint resolves `releases/latest/download/latest.json` to the newest
   release, so existing installs see the update immediately.

> The very first release with auto-update must be installed manually (there's no prior version
> to update from). From then on, updates are in-app.
