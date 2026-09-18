# Portable plan-definition JSON

This format carries only a plan definition. It contains no journal identity,
definition-version ID, enrollment, completion, scheduling state, or scripture
text. Importing it is a separate, explicit application action; this document
does not define database import, adoption, or filesystem behavior.

The native codec accepts at most 1,000,000 UTF-8 bytes. It rejects malformed or
trailing JSON, unknown fields, unsupported `schemaVersion` values, and values
that fail the same validation used for persisted plan definitions. Version 1 is
the currently supported format. Fields use lower camel case.

An explicit schedule uses ordered, consecutive `day` values and one or more
validated passage references per day:

```json
{
  "schemaVersion": 1,
  "name": "Synthetic three-day plan",
  "description": "A portable example, not a built-in schedule.",
  "schedule": {
    "kind": "explicitSchedule",
    "days": [
      {
        "day": 1,
        "passages": [
          { "book": 43, "chapter": 3, "startVerse": 16, "endVerse": 21 }
        ]
      }
    ]
  }
}
```

A chapter-stream definition supplies stable lowercase IDs, display names, and
canonical chapter references. Repeated chapter references are allowed when they
are intentional; a later enrollment chooses an explicit zero-based stream
position.

```json
{
  "schemaVersion": 1,
  "name": "Synthetic streams",
  "schedule": {
    "kind": "chapterStreams",
    "streams": [
      {
        "id": "new-testament",
        "name": "New Testament",
        "chapters": [
          { "book": 40, "chapter": 1 },
          { "book": 40, "chapter": 2 }
        ]
      }
    ]
  }
}
```

Passage and chapter book numbers follow canonical Protestant 66-book order.
Whole-chapter passages omit `startVerse` and `endVerse`; a range includes both.
The native library exposes `parse_plan_definition_json` and
`serialize_plan_definition_json` for this bounded, validated exchange format.
