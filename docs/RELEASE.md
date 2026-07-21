# Release procedure

> Internal — for the developer (you), not the client.

## One-time GitHub setup

```bash
cd "/path/to/Slace Angine"

# Initialise the repo (skip if already done)
git init
git add .
git commit -m "chore: initial commit"

# Create a private repo on GitHub via gh CLI or web UI. With gh:
gh repo create scale-engine --private --source=. --remote=origin --push

# Or, after creating via web:
git remote add origin git@github.com:<your-account>/scale-engine.git
git branch -M main
git push -u origin main
```

GitHub Actions are wired up out of the box (`.github/workflows/`):
- **`ci.yml`** — runs on every PR / push to main: TypeScript build + smoke test.
- **`release.yml`** — runs on `v*` tags: builds Windows `.exe` and macOS `.dmg`, attaches both to a new GitHub Release.

## Releasing a new version

1. Bump the version in **`package.json`** (`"version": "1.0.1"`).
2. Add a section to **`CHANGELOG.md`** with the changes.
3. Commit and tag:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: release 1.0.1"
   git tag v1.0.1
   git push origin main --tags
   ```
4. Watch the Actions tab on GitHub. After ~5-10 minutes, the release will appear under **Releases** with attached `.exe` and `.dmg`.
5. Send the `Scale-Engine-Setup-1.0.1.exe` URL to the client, along with `docs/CLIENT-GUIDE.md` if they're new.

## Building locally

### macOS (your machine)

```bash
npm install
npm run dist:mac          # creates release/Scale-Engine-1.0.0-arm64.dmg + -x64.dmg
```

### Windows .exe from macOS

Cross-building Windows installers from macOS needs Wine:

```bash
brew install --cask wine-stable
npm run dist:win          # creates release/Scale-Engine-Setup-1.0.0.exe
```

If Wine is missing or fails, use the GitHub Actions path instead — it always works because it builds on a real Windows runner.

## Replacing the placeholder icon

`build/icon.ico`, `build/icon.icns`, `build/icon.png` aren't shipped in the
repo yet (electron-builder falls back to the generic Electron icon).

Drop a 1024×1024 PNG of the logo into `build/logo-1024.png`, then:

```bash
npm i -D electron-icon-builder
npx electron-icon-builder --input=./build/logo-1024.png --output=./build --flatten
```

This generates all three icon files. Commit them and they'll be picked up by
the next build automatically.

## Pre-flight checklist

Before tagging a release intended for the client, verify:

- [ ] `npm run build` finishes with no TypeScript errors.
- [ ] `npm start` launches and the UI renders correctly.
- [ ] Save / Start / Stop cycle works end-to-end against a real SFTP.
- [ ] An XML dropped into the local Export folder makes it to `/upload/import` and the local copy moves into `processed/`.
- [ ] An XML placed into `/upload/<FolderName>/export/` on SFTP arrives in the local Import folder and the remote moves into `processed/`.
- [ ] Disconnect the network for 30 seconds — log shows reconnect with backoff, traffic resumes when network returns.
- [ ] `CHANGELOG.md` and `package.json` version are updated.
- [ ] The activity log doesn't print the password (only its length + last 2 chars).
