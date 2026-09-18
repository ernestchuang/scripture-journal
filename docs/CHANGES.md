# Changes worth knowing about

This is a user-facing record of delivered behavior and useful additions. Beads
holds implementation status and remaining acceptance work.

## 2026-09-18

- Light, Dark, and System appearance apply before the desktop window appears.
  System uses a compatible active desktop palette when its bounded source file is
  available, otherwise follows OS light/dark changes. The palette is memory-only:
  a removed or malformed source falls back to the OS rather than retaining stale
  colors. Explicit choices persist on the device. Automated browser tests run
  headlessly with dark appearance by default.
- Import your own color palettes through **Import theme** using the documented
  [TOML format and example](THEMES.md). System checks a compatible active desktop
  palette every three seconds without changing OS settings. Failed preference saves
  are reported. Custom colors are restored before application rendering.
- **Additional draft protection:** continuous typing now triggers a save at least
  every five seconds while storage is responding normally, alongside the existing
  600 ms idle save. A failed save stays visible and does not repeatedly retry in
  the background. Every persisted changed version remains in history.
- **Additional conflict recovery:** after a failed save, “Save as new draft”
  preserves current writing in a separate unfinished entry. This lets a draft
  recover when another app instance changed the original. The original and its
  history remain intact; if saving the copy fails, the current draft stays open.
- Reading-plan, revision, and export defaults are recorded in
  [the release decision](decisions/0002-release-defaults.md). These are delegated
  implementation choices, not a claim that the whole release is already built.
- The reading-plan storage foundation now preserves immutable versions and
  validates chapter and verse references. Its database upgrade preserves existing
  linked journal entries and revision history. Plan enrollment, progress, and the
  plan editor are still being built; this foundation does not yet add a plan UI.

Astra reviewed the appearance source and the draft-protection additions. Native
visual startup and actual Apple Silicon runtime validation remain separate
acceptance work; the current app is still a prototype.
