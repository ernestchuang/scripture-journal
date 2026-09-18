# Local Scripture packs

The desktop reader can import local JSON packs for `LSB`, `NASB1995`, `ESV`, and
`KJV`. This is an import facility, not a license or a bundled source of those
translations. Obtain text you are authorized to store and retain its required
copyright/source attribution. The app never uploads or exports imported Bible
text with journals or full journal backups.

Choose **About translations & availability → Import authorized Scripture pack**.
Selecting a valid file replaces that translation's library atomically and switches
the reader to it. Other translations and journal writing remain intact. An invalid
file or failed write leaves the existing library untouched. Source attribution is
displayed beneath the reader. Desktop downloads survive restart; browser preview
does not import packs.

The UTF-8 JSON format is versioned and limited to 50 MiB. The following is a shape
example, not an installable complete pack:

```json
{
  "formatVersion": 1,
  "translation": "ESV",
  "name": "Edition name supplied with your authorized text",
  "source": "Source, edition and required copyright attribution",
  "chapters": [
    {"book": 1, "chapter": 1, "verses": [{"number": 1, "text": "Synthetic example only"}]}
  ]
}
```

A pack must list all 1,189 chapters in Protestant 66-book order (Genesis=1,
Revelation=66), each once, with its positive chapter number. Verses start at 1 and
have consecutive numbers and nonempty plain text. Represent an omitted verse with
an explicit editorial omission notice supplied by the source. Up to 200 numbered
verses per chapter and 100,000 UTF-8 bytes per verse are accepted. No HTML executes.
Unknown fields and unsupported format/translation IDs are rejected.

Import validation checks chapter coverage, numbering, size, and structure. It
cannot establish text authenticity, completeness within each chapter, copyright
permission, or the accuracy of a pack's edition label. Verse numbering can differ
between translations; this import does not remap it to KJV numbering. The built-in
KJV downloader additionally validates its known source's exact chapter lengths.
