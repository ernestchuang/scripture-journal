# Desktop test packages

The **Desktop test packages** GitHub Actions workflow builds the selected Git
revision on demand. It produces Linux x86-64 AppImage/deb files and Apple Silicon
arm64 macOS app/dmg files. Download the workflow artifacts; no GitHub release is
published automatically. Artifacts expire after 30 days.

Each artifact contains a JSON manifest with the exact source commit, target,
runner architecture, file sizes, and SHA-256 checksums. The executable's reported
architecture is recorded and checked separately from the runner label. The macOS
app is zipped with its permissions and resources preserved.

These are unsigned test builds, not notarized public releases. A successful
package build does not prove native runtime behavior or installation acceptance
on your own computer. Linux webview/system library requirements still apply;
AppImage is the intended test artifact for Arch, while deb is for Debian-family
systems. OS trust/install prompts and device-specific interaction remain part of
manual acceptance. The app has no account or synchronization service.

Local builds use `npm ci` followed by `npm run desktop:build`. The output is under
`src-tauri/target/release/bundle/` unless a target or `CARGO_TARGET_DIR` is supplied.
The application identifier is separate from the original app. Keep the original
installation and journal until import and recovery have been verified.
