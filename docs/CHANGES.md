# Changes worth knowing about

This is a user-facing record of delivered behavior and useful additions. Beads
holds implementation status and remaining acceptance work.

## 2026-09-18

- Light, Dark, and System appearance apply before the desktop window appears.
  The choice persists on the device, and System follows OS light/dark changes.
  Automated browser tests run headlessly with dark appearance by default.
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

Astra reviewed the appearance source and the draft-protection additions. Native
visual startup and actual Apple Silicon runtime validation remain separate
acceptance work; the current app is still a prototype.
