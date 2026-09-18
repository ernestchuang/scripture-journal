# Translation source investigation

Checked 2026-09-17. Source availability and permission for full offline storage are
separate questions. This records implementation evidence, not new product scope.
The requested editions remain LSB, NASB1995, ESV, and KJV.

| App edition | Candidate / identity | First-slice status |
| --- | --- | --- |
| KJV | bible-api.com `kjv`; provider identifies King James Version | Live chapter reading; no whole-Bible download through chapter endpoints |
| LSB | Legacy Standard Bible, 2021; old Bolls identifier `LSB` | Integration deferred; full offline authorization unresolved |
| NASB1995 | New American Standard Bible 1995; old Bolls code `NASB` needs edition verification | Integration deferred; never substitute NASB2020 silently |
| ESV | Crossway ESV API; API edition/version must be recorded | Integration deferred; public API conditions do not authorize full offline storage |

## Publisher and provider evidence

[LSB permission policy](https://lsbible.org/permission-to-quote-the-lsb/) permits
limited quotation under stated conditions and caps electronic retrieval storage
at 1,000 verses. It requires attribution and directs broader requests to its
permission process. No full offline redistribution grant was established here.

[Lockman NASB policy](https://www.lockman.org/permission-to-quote-copyright-trademark-information/)
also limits ordinary quotation/electronic storage to 1,000 verses with additional
conditions. Its notice must match the edition; NASB1995 attribution must not imply
NASB2020 content. The old provider code alone is not proof of edition or rights.

[Crossway ESV API terms](https://api.esv.org/) allow bounded non-commercial API
integration and limited caching, with a 500-verse ceiling and a half-book limit.
The page gives request limits and licensing conditions for broader use. This
does not establish permission to download all chapters. API keys must not be
embedded as shared secrets in a distributed desktop binary.

[bible-api.com documentation](https://bible-api.com/) lists KJV, supports CORS,
and provides both passage and book/chapter endpoints. Single-chapter books need
unambiguous requests. Its stated rate limit is 15 requests per 30 seconds; it
asks clients not to download a whole Bible through the API. The first reader
fetches on demand, reports failures, and uses synthetic test fixtures.

[eBible.org's KJV edition](https://ebible.org/kjv/copyright.htm) identifies its
1769 standardized text as public domain outside the UK and documents the UK
restriction. It is a future offline-source candidate, not the exact dataset
currently served by bible-api.com. A downloadable package still needs pinned
provenance, edition checks, checksums and appropriate distribution scope.

[Bolls API documentation](https://github.com/Bolls-Bible/bain/blob/master/docs/API.md)
offers chapter and whole-translation endpoints and explicitly discourages using
chapter requests for bulk downloads. It is evidence of a transport interface,
not by itself a publisher grant covering the copyrighted editions.

## Implementation consequence

Do not block journal persistence, planning algorithms, or reader interaction tests
on full-text licensing. The first slice uses KJV on demand and clearly identifies
unavailable editions. Future offline packs need documented provenance/terms before
being enabled. No publisher has been contacted and no permission request submitted.
No full copyrighted Bible text was downloaded or committed for this investigation.

Research acceptance is satisfied by this source matrix; full-source integration
and offline rights remain explicit follow-up work in Beads. Journal export contains
user writing and passage references, not an automatically embedded Bible library.
