# Build resources

This folder is read by `electron-builder` for icons, installer banners and
platform-specific entitlements. Replace the placeholder files below with real
artwork before shipping a client build.

| File           | Used on        | Required size                |
|----------------|----------------|------------------------------|
| `icon.ico`     | Windows        | Multi-resolution, ≥ 256×256  |
| `icon.icns`    | macOS          | Multi-resolution, ≥ 512×512  |
| `icon.png`     | Linux fallback | 512×512                      |

Easiest way to generate all three from one PNG:

```bash
npx electron-icon-builder --input=./logo-1024.png --output=./build --flatten
```

(One-time install: `npm i -D electron-icon-builder`.)

Until real icons are dropped here, `electron-builder` will use a generic
Electron icon — the installer still works and the app still runs.
