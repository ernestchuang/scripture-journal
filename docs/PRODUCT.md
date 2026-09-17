# Scripture Journal product specification

This document preserves product requirements and proposed behavior for the rewrite.
It is a specification, not a task tracker; implementation work belongs in Beads.
“Confirmed” records user decisions. “Proposed” identifies defaults to validate.

## Purpose and audience

**Confirmed:** The initial audience is the owner and his wife, with possible small-group use later.
The application combines Bible reading, reflective writing, and revisiting connected entries.
Journals are local and private by default. Sharing entries may be added later.
Obsidian is for browsing, connections, and deeper study after export, not primary writing.

## Platforms and delivery boundary

**Confirmed:** The first release targets Arch Linux laptops and Apple Silicon macOS.
The design must accommodate future iPad and iPhone applications.
Initial delivery includes no sync provider, account system, or entry-sharing service.
Future synchronization, sharing, and end-to-end encryption must remain possible.
Those future capabilities are not promises of compatibility with any selected provider.
Until synchronization exists, each installation maintains its own local journal.

**Proposed:** Keep domain commands independent of windows, filesystem dialogs, and desktop layout.
Use adaptable reader/editor layouts and avoid hover-only, right-click-only, or drag-only actions.
Keyboard navigation, visible focus, readable typography, and accessible controls are baseline design goals.
Whether one installation supports switching between multiple local journals remains undecided.

## Confirmed first-release capabilities

| Area | Required behavior |
| --- | --- |
| Scripture | Read and navigate passages, resume reading, and support offline scripture availability. |
| Translations | Switch among LSB, NASB1995, ESV, and KJV; no side-by-side comparison initially. |
| Continuous reading | Scroll beyond assigned passages and across chapter/book boundaries. |
| Writing | Create, edit, and delete journal entries, with optional titles, tags, and passage associations. |
| Draft protection | Preserve unfinished writing through navigation, pane closure, and application restart. |
| Passage connections | Associate entries with multiple passages and find entries related to a passage. |
| Entry connections | Maintain internal links and backlinks through the authoritative local database. |
| Revisit | Browse chronologically and search writing, with passage and tag filtering. |
| Plans | Include two starting plans and support custom reading plans that can change over time. |
| Templates | Provide template infrastructure and one simple or blank starter template. |
| History | Retain all committed versions until explicitly deleted. |
| Portability | Import existing journals/progress, export Markdown, and support full backup/restore. |
| Obsidian | Maintain an existing export while the desktop application runs. |

Translation selection expresses product intent, not a claim of acquired distribution rights.
Source access, offline storage, and export permissions must be verified for each translation.

## Read flow

Open the reader from a saved location, direct passage navigation, or a reading-plan assignment.
The active assignment supplies a destination and reading context; it never bounds the Bible reader.
A short assignment such as John 3:16–21 must still allow scrolling into surrounding chapters.
Scripture browsing, assignment selection, and completion are separate pieces of state.

**Proposed:** Highlight the assigned range and offer “Return to assigned reading” after exploration.
Mark readings complete through an explicit action rather than inferring completion from scrolling.
Preserve a verse anchor when switching translation, opening the editor, or resizing the window.
Show loading or unavailable-text states without discarding the current position.
At the beginning/end of the Bible, stop naturally rather than wrapping automatically.
Downloaded content should remain readable offline; unavailable content should be identified clearly.

## Write flow

Start a blank entry directly or start a reflection from a passage/selection.
Writing can stand alone; selecting scripture is not a prerequisite.
An entry may connect several passages and link to other entries.
Internal links address stable entry identities, independent of exported paths and changing titles.
Backlinks expose current entries that reference the selected entry.

**Proposed:** Pin the initial passage association when creating the draft.
Scrolling to another chapter must not silently change that association.
An explicit “Add current passage” action adds another association.
Show saving, saved, and actionable failure states; failed writes must retain recoverable content.
Switching entries or views restores unfinished drafts rather than replacing them.
Templates insert editable starting content; modifying a template never rewrites existing entries.
Use a blank starter template to prove the template workflow without prescribing a study method.

## Revisit flow

Browse entries by date, search their text, or open related reflections from the reader.
Follow entry links and backlinks inside the application without opening Obsidian.
Open revision history to inspect prior writing and restore an earlier state.

**Proposed:** Search results include sufficient text and passage context to identify an entry.
Current backlinks reflect current entry content; historical links remain visible in revision history.
A link to an entry in Trash explains the state and offers recovery where possible.
An external graph view is not required to make internal connections useful.

## Reading plans

**Confirmed starting plan 1:** M’Cheyne’s reading plan, using its established daily assignments.
**Confirmed starting plan 2:** One chapter per day from each of four categories:

- Old Testament excluding Psalms and Proverbs.
- New Testament.
- Psalms.
- Proverbs.

Custom plans must accommodate changing schedules without erasing previously recorded reading.
Plan definitions, a person's enrollment/schedule, and completion history are distinct concepts.

**Proposed:** Support explicit daily passage lists and independently advancing chapter streams.
Version edited plan definitions and make adoption by an active enrollment deliberate.
Preserve the definition/version that explains past assignments and completed readings.
Provide a plan editor and a documented import/export format; that format remains to be selected.

**Unconfirmed defaults:** Canonical book order, Genesis/Matthew/Psalm/Proverb starting positions,
adjustable initial positions, automatic stream looping, and missed-day carry-forward are proposals.
Calendar-driven versus completion-driven advancement is not yet a confirmed user preference.
M’Cheyne start-date alignment and leap-day handling also require an explicit scheduling policy.
An individual stream's completion or restart must not implicitly reset the other streams.

## Drafts and permanent revision history

**Confirmed:** All versions remain available unless explicitly deleted; no automatic history pruning.
**Proposed:** Each persisted autosave is a retained immutable revision; no persisted
draft version is overwritten or expired. Coalesce typing only before the next write.
The working revision head identifies unfinished writing; a separately finished head
identifies content eligible for ordinary export. “Finished” does not mean shared.
The precise autosave cadence remains a design decision. Do not promise that every
keystroke survives a crash before its database write commits.
Each durable revision captures writing, title, tags, passage associations, and outgoing entry links.
Restoring an older revision creates a new current revision and retains intervening versions.
Use Trash for ordinary entry deletion; permanent entry/history deletion is an explicit action.
History can be grouped visually without deleting stored revisions.

## Data ownership, export, and recovery

**Confirmed:** The local database is authoritative for entries, relationships, and revisions.
Markdown exports are readable derivatives; external Obsidian edits are not automatically imported.
The desktop exporter updates existing exported documents rather than repeatedly creating duplicates.
Stable export identities must preserve links from independently authored Obsidian notes.

**Proposed:** Export the latest finished entry versions into an application-managed vault folder.
Unfinished edits stay in the app and full backup until finished explicitly.
Write internal entry links as navigable links between exported documents.
Detect externally changed generated files and report conflicts instead of silently overwriting them.
Keep user-authored Obsidian notes outside the managed export area.
Use incremental export and resumable batches so ordinary work processes changed entries only.
Full backups include drafts, permanent revisions, relationships, and reading progress.
Restore and migration must validate imported data and report omissions or conflicts.
Migration preserves source files; a readable Markdown export is not a substitute for full backup.

## Acceptance scenarios

1. Open John 3:16–21 from a plan; scroll into John 2 and John 4 without completing the assignment.
2. Start a John 3 draft, navigate to Romans 8, and reopen it: John 3 remains attached.
3. Add Romans 8 explicitly; the same entry is discoverable from both associated passages.
4. Write offline, close the application, and reopen it: unfinished content and associations recover.
5. Rename a linked entry: outgoing links and backlinks still resolve to the same identity.
6. Remove a link: its current backlink disappears while the prior revision preserves the relationship.
7. Restore an old revision: the restored content becomes current and all intervening versions remain.
8. Edit an active plan: completed history remains intact and version adoption is explicit.
9. Advance the Proverbs stream: unrelated stream positions remain unchanged.
10. Switch translation or narrow the desktop layout: retain the passage anchor and active draft.
11. Change a template: previously created entries retain their content.
12. Edit and finish one entry: update its Obsidian export without rewriting unrelated documents.
13. Modify an exported file externally: export reports the conflict and preserves the external content.
14. Restore a full backup: entries, drafts, links, revisions, and progress remain available.
