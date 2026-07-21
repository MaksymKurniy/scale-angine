# Changelog

All notable changes to Scale Engine will be documented here.
This project loosely follows [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-07-08

Rename from **Scale Angine** to **Scale Engine** — the earlier name was a
typo carried over from the legacy build. This is a minor-version bump
because the change is user-visible (window title, installer, shortcut,
Start-menu entry, macOS bundle) and technically breaking at the installer
level: on Windows the new build installs alongside the old, so operators
should uninstall the previous "Scale Angine" entry from Settings → Apps
before running the new one. On macOS the same DMG/app-bundle rename
applies.

### Changed
- Product name in every user-visible surface (`productName`, window title,
  installer, log messages, README, client guide).
- Application ID (`com.basex.scale-angine` → `com.basex.scale-engine`).
- Installer output filenames (`Scale-Engine-Setup-1.1.0.exe`,
  `Scale-Engine-1.1.0-arm64.dmg`, `Scale-Engine-1.1.0-x64.dmg`).
- Package name (`scale-angine` → `scale-engine`).

### Added
- **Transparent userData migration.** On first launch the new build looks
  for the old `.../Scale Angine/scale-angine-config.json`; if the new
  location is empty and the legacy file exists it is copied over. Clients
  who upgrade preserve their SFTP URL, password, folder name and
  directories with no manual re-entry.

## [1.0.1] — 2026-07-06

Long-running stability fixes. The v1.0.0 build survived hours but silently
went deaf after ~day-long runs — the SSH tunnel would die without emitting
`close`/`end` events (typical NAT drop), our watchers would then hang on the
next SFTP call forever, and the `busy` guard would lock every subsequent
tick out. UI kept working; file traffic stopped. This release closes every
known way that could happen.

### Fixed
- **SSH keepalive.** Added `keepaliveInterval: 20s` and `keepaliveCountMax: 3` to the ssh2 connect options. A dead tunnel is now detected within ~60s and triggers our existing auto-reconnect.
- **Per-operation SFTP timeout.** Every `list/put/get/rename/exists/mkdir` call is wrapped in a 30-60s `Promise.race`. A timed-out op force-closes the client (which triggers reconnect) instead of hanging forever.
- **Tick watchdog.** Each watcher tick is now bounded by a 90s hard timeout. If it fires, the tick is aborted, the connection is marked dead, and the next scheduled tick attempts fresh work.
- **Busy lock replaced with time-based lock.** The old boolean `busy` flag could latch to `true` forever if a tick promise never resolved. Replaced with `busyUntil` timestamp that auto-expires.

### Added
- **Heartbeat log.** Every 5 minutes the Agent emits `heartbeat: up 3h12m, sftp connected, export tick 4s ago, import tick 2s ago, rss=142MB heap=38MB` and, on a separate line, `DNS: host -> 34.55.19.201`. On a quiet store, this gives the operator visible evidence the agent is alive; memory numbers surface slow leaks; the DNS line catches stale Node.js DNS-cache bugs after network changes.
- **Stale-tick warning.** If no successful tick happens for over 5 minutes, a WARN is logged so quiet periods don't blend into silent-death periods.
- Both watchers now expose `getLastSuccessAt()` used by the heartbeat.

### Fixed (round 2 — belt-and-suspenders)
- **`closeClient()` has a 5s hard timeout.** Previously `await client.end()` could theoretically hang on a half-open TCP socket. Now the client reference is nulled up front and any lingering stream is force-closed via `destroy()` if `end()` doesn't return in time. Prevents zombie references surviving Stop.
- **`Watcher.stop()` now fully resets internal state.** The watcher services are NestJS singletons, so `inFlight`, `busyUntil`, `lastSuccessAt`, and `staleWarned` used to survive across Stop→Start cycles within the same process. If a transfer hung mid-flight, its filename could remain in `inFlight` and be silently skipped forever until a full app restart. Now cleared on every Stop.
- **`AgentService.start()` forces a full SFTP tear-down and reconnect.** `SftpService.connect(uri, pwd, force=true)` — even if the service thinks it's connected, the old client is discarded and a fresh session is opened. Guards against the "connected=true, socket-dead" zombie state.
- **Hourly restart also uses `force=true`** so the periodic self-heal is airtight for the same reason.

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
