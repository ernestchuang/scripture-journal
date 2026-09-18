# M’Cheyne built-in plan source

The native definition follows the complete 365-day calendar published at
<https://www.mcheyneplan.com/calendar.html>. The checked-in schedule was captured
on 2026-09-18 (download SHA-256
`5bf52e2127008fc3c8767d1a2d1eaa535138ee1f100da66ad375bb0c1dc6519c`) and
normalized from its four reading columns into canonical Protestant book
numbers. A reading spanning chapters becomes adjacent passages in the same
daily set; partial chapters retain their inclusive verse bounds. The normalized
fixture SHA-256 is
`bc316a3516ddf584706274011543a42522098346ee41c6cc68d3a820ca025c21`.

The opening and closing sets, multi-chapter readings, and split-chapter
boundaries were also checked against the December 1842 calendar reproduction at
<https://www.mcheyne.info/calendar.pdf> (download SHA-256
`76bc6e96ad1f59ea6e12ff966f1485ec5ad82022cdf72ae3096f8a366ad46d21`).
The HTML transcription uses the widely published modern split at Exodus
11:1–12:20 / 12:21–50 and Psalm 78:1–39 / 40–72. The March 1 row of the
calendar reproduction explicitly ends the Exodus reading at 12:51, so the
normalized fixture corrects the HTML's omitted verse to 12:21–51. The Psalm
split differs only in typography; the normalized fixture has no omitted or
duplicated verses under canonical KJV verse counts.

The earlier application's `src/data/mcheyne.json` was inspected but not reused:
it collapses split-chapter boundaries and its fourth reading diverges from the
calendar, ending with Psalm 150 instead of John 21.
