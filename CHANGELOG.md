# Changelog

All notable changes to Scale Angine will be documented here.
This project loosely follows [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-05-17

Initial reconstructed release.

### Added
- Electron + NestJS architecture with everything running in a single OS process.
- Two-way XML proxy:
  - Local `Export/` → SFTP `/upload/import` (middleware inbox)
  - SFTP `/upload/<FolderName>/export/` → local `Import/` (POS App inbox for the scale)
- Configurable polling (default 2.5 s) with `mtime` stability check (1.5 s) to avoid grabbing files mid-write.
- Successfully transferred files are archived to `processed/` on the appropriate side with an ISO-timestamped name.
- Separate SFTP URL and SFTP Password fields with a show/hide toggle.
- Robust URI parser tolerant of raw special characters in passwords (`/`, `+`, `:`, `@`, `=`, `%`).
- Password encryption at rest via Electron `safeStorage` (DPAPI on Windows / Keychain on macOS / libsecret on Linux), with a transparent migration path from legacy plain-text configs.
- Automatic SFTP reconnect with exponential backoff (1s → 30s) on dropped sessions.
- Console-style activity log inside the window mirroring the agent's structured event bus.
- Confirm-on-close guard when the agent is running.
- Uncaught exception / unhandled rejection logging.
- `electron-builder` configuration producing NSIS installer (Windows x64) and DMG (macOS arm64 + x64).
- GitHub Actions workflows: `ci.yml` (type-check + smoke test on PRs/branches) and `release.yml` (cross-platform build + publish on `v*` tags).
