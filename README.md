# Scale Angine

> Documentation map: this README is the technical/developer overview.
> See [`docs/CLIENT-GUIDE.md`](docs/CLIENT-GUIDE.md) for an end-user guide and
> [`docs/RELEASE.md`](docs/RELEASE.md) for the release procedure.

Proxy gateway between **Mettler Toledo** scales and an **SFTP** server. Sits on the cashier/back-office PC, watches two directories in parallel, and shuttles XML files in both directions:

- **Export → SFTP**: when the scale drops a receipt XML into the local *Export* directory, Scale Angine uploads it to **`/upload/import`** on the SFTP server (the middleware's shared inbox; it then moves files to `/upload/import_processed` or `/upload/import_error` on its own). The local copy is archived under `<Export>/processed`.
- **SFTP → Import**: when the POS App publishes a product XML into **`/upload/<FolderName>/export/`** on the SFTP server, Scale Angine downloads it into the local *Import* directory (where Mettler Toledo picks it up) and moves the remote file to `/upload/<FolderName>/export/processed`.

## Stack

- **Electron** — desktop shell with native folder pickers
- **NestJS** — modular service layer running inside the Electron main process (single OS process, no extra ports)
- **ssh2-sftp-client** — SFTP transport
- TypeScript everywhere on the main side; plain HTML/CSS/JS for the renderer (no bundler)

## Project layout

```
src/
  main/                 Electron main + NestJS bootstrap + IPC
    nest/
      config/           Persisted app config (SFTP URI, paths…)
      sftp/             Single shared ssh2-sftp-client wrapper
      watcher/          ExportWatcher and ImportWatcher (polled every 2.5s)
      agent/            Start/stop orchestrator
      logger.service.ts In-process log bus mirrored to the renderer
  renderer/             UI (index.html + styles.css + renderer.js)
```

## Running

```bash
npm install
npm start
```

`npm start` compiles `src/main` to `dist/main`, copies `src/renderer` to `dist/renderer`, then launches Electron.

## Configuration

All four fields are stored as JSON in Electron's per-user `userData` folder (`scale-angine-config.json`):

| Field            | Purpose                                                                                        |
|------------------|------------------------------------------------------------------------------------------------|
| SFTP URL         | `sftp://user:pass@host:22` (port optional, defaults to 22)                                     |
| Folder Name      | Sub-folder under `/upload/` assigned to this scale (e.g. `DIsaH6`)                             |
| Import directory | Local folder Mettler Toledo reads product XMLs from. Scale Angine writes here.                 |
| Export directory | Local folder Mettler Toledo writes receipt XMLs to. Scale Angine reads here.                   |

Three buttons control the agent:

- **Save** — persists the form without starting anything.
- **Start** — saves, opens the SFTP session, and starts both watchers. Stays running until **Stop** is pressed or the window is closed.
- **Stop** — stops both watchers and closes the SFTP connection.

## Behaviour notes

- Polling interval is **2.5 s** (`POLL_MS` in both watcher services). A file is skipped on a given tick if its `mtime` is newer than **1.5 s** to avoid grabbing a file mid-write.
- Processed files are renamed with an ISO timestamp prefix (`2026-05-17T10-15-22-333Z__<name>`) so collisions are impossible.
- Connection errors and missing config items are reported to the activity log and turn the status dot red.
- Dropped SFTP sessions are detected via `end`/`close`/`error` events; the service reconnects with exponential backoff (1s → 30s) for as long as the user keeps the agent in the **Running** state.
- The SFTP password is stored encrypted at rest using Electron's `safeStorage` (DPAPI on Windows / Keychain on macOS). The config file holds it as `enc:<base64>`; legacy plain-text values from older versions are migrated transparently on the next save.

## Packaging

`electron-builder` is configured to produce:
- **Windows**: NSIS installer (`Scale-Angine-Setup-<version>.exe`, x64)
- **macOS**: DMG (`Scale-Angine-<version>-<arch>.dmg`, arm64 + x64)
- **Linux**: AppImage (best-effort fallback)

```bash
npm run dist:win     # Windows installer (needs Wine on macOS — see docs/RELEASE.md)
npm run dist:mac     # macOS DMG
npm run dist:all     # Both (multi-target)
```

For repeatable client builds, push a `v*` tag and let GitHub Actions
(`.github/workflows/release.yml`) build on real Windows and macOS runners and
upload the artifacts to a GitHub Release.
