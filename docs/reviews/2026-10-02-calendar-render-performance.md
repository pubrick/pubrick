# Calendar render performance — 2026-10-02

## Reproduction

The complete web run timed out in calendar bulk selection at the existing
20-second deadline. A serial rerun of four affected files passed 213 of 214
tests; selecting 20 topics was the remaining failure. The subsequent test also
reported unfinished updates outside `act`. No timeout was raised and no assertion was removed.

## Diagnosis and change

Every checkbox update recreated month/date/time formatters, seven weekday
formatters and 42 day formatters while the displayed month was unchanged.
Native `Intl.DateTimeFormat` instances now stay scoped to the mounted calendar
and rebuild when its locale changes. Formatting options, local date semantics
and accessibility labels are preserved. Native Intl was retained rather than
adding a second date-formatting dependency.

The test repeatedly searched every document element for a label while each
selection added another date input. It now identifies the accessible topics
group and checkbox choices once, then performs the same 20 awaited user clicks.
It still checks that choice 21 is disabled and the exact selected count is 20.
The 20-second deadline and real interaction path are retained.

Independent read-only review found no hook-order, locale-refresh or retained
DOM reference problem; topic nodes are stable and keyed by topic ID.

## Evidence

All 15 calendar-page tests passed in 42.84 seconds. The previously failing
selection test completed in 3.55 seconds. The run emitted no act warnings.
This is evidence from the local test environment, not a production benchmark
or a promise of equivalent timing on other machines.

After removing an unsupported test-query option, the final exact-case check
passed in 4.68 seconds (14 other tests intentionally excluded by the name
filter), and the web TypeScript check passed. Affected Biome checks also passed.
No production logic changed in that follow-up. The original full-suite result remains recorded; it was not
rerun unnecessarily and is not retroactively described as green.
