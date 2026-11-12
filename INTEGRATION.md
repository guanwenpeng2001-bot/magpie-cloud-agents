
## Integration validation (2026-11-12)

PR #2 fixes macOS Grok Bot app discovery and managed profiles, supports the current app surface, and makes background model discovery passive. Direct Connect remains Windows-only. PR #3 adds Qoder and preserves the main session pointer across divergent auxiliary requests.

Windows integration testing initially found three failures in Qoder self-hosted execution: `/bin/bash` was unavailable and backslash-separated paths broke glob matching/output. The integration fixes discover Git for Windows Bash and normalize file-tool paths. A real timeout test then exposed surviving Bash children; cancellation now terminates the process tree (Windows) or process group (POSIX). An already-aborted request cannot start a shell. Windows self-hosted Bash requires Git for Windows installed in a standard system or per-user location; file-only tool configurations do not require Bash.

macOS teardown additionally rejects absent/malformed managed tags before comparing pid, executable path and creation stamp, including the synchronous exit path. Injected-process tests cover each identity mismatch and valid teardown.

Validation uses local fake vendor services, not paid live vendor requests. macOS app behavior was reported as live-tested by the PR author; this integration was tested on Windows, with macOS discovery/process behavior covered by injected fixtures. Visible-text completion remains heuristic, as documented in PR #2. Self-hosted Bash is not a filesystem sandbox.

Final Windows validation: 1,104 tests passed, 0 failed across 24 files (bun 1.4.0); bun scripts/check.mjs --stubs passed for all seven providers with zero transport attempts; git diff --check passed.
