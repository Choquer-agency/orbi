# Progress

## Status
Completed research brief for Electron + React email client performance.

## Tasks
- Researched Electron startup/performance best practices.
- Researched React list virtualization/profiling patterns.
- Researched Convex query/subscription scalability patterns.
- Researched local cache/offline mailbox architectures.
- Researched email HTML rendering/sanitization tradeoffs.
- Wrote tailored Orbi implementation playbook.

## Files Changed
- `/tmp/orbi-perf-research.md`
- `/Users/johnnynguyen/Documents/Repos/orbi/progress.md`

## Notes
- Key recommendation: Orbi needs a local-first mailbox cache plus virtualized UI and narrower Convex subscriptions to feel like Gmail/Spark in packaged Electron.
- Existing installed apps still require one updater-enabled install; future release reliability depends on signed/notarized builds.
