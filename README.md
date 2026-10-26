# JAM — JIRA Assets Manager

A cross-platform desktop app (Windows, macOS, Linux) for managing IT assets stored in **Jira Assets** (formerly Insight). It provides a fast, editable data grid, a quick-scan workflow for barcode scanners, and a visual label designer with batch printing.

> [!WARNING]
> **This project is fully AI-generated ("vibe coded").** The code, configuration and this documentation were produced by an AI assistant with human direction and light review. It has not had a formal security audit or thorough testing. Review the code before using it against production data, and use at your own risk.

> [!CAUTION]
> ## READ BEFORE USING: THIS APP ASSUMES A SPECIFIC JIRA ASSETS SCHEMA LAYOUT
>
> **JAM is built around ONE setup: a single schema ("XYZ Enterprises Assets") where EACH BRANCH IS AN OBJECT TYPE, and every branch object type shares the same common attributes (`Asset Tag`, `CPU`, `Model`, ...).**
>
> **If your Assets schema is organised by kind of asset instead (an "Assets" schema with object types such as `Software`, `Laptop`, `Desktop`, `Mobile Device`), this software MAY NOT WORK FOR YOU.**
>
> See [Assumptions about your Assets schema](#assumptions-about-your-assets-schema) for details.

## Screenshots

> Screenshots are not yet included. Add images to `docs/screenshots/` using the file names below and they will render here.

| Dashboard | Assets grid |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Assets grid](docs/screenshots/assets.png) |

| Quick Scan | Label designer |
| --- | --- |
| ![Quick Scan](docs/screenshots/quick-scan.png) | ![Label designer](docs/screenshots/label-designer.png) |

| Settings | Dark mode |
| --- | --- |
| ![Settings](docs/screenshots/settings.png) | ![Dark mode](docs/screenshots/dark-mode.png) |

## Features

### Assets grid
- Browse every object of the selected schema and object type in a virtualised table (TanStack Table), so large datasets stay responsive.
- **Inline editing**: double-click a cell to edit text, numbers, dates, status, select and object-reference attributes. Edits are applied optimistically and rolled back with an error toast if the API call fails.
- **Reference picker**: debounced, searchable autocomplete for object-reference attributes (users, other assets).
- **Detail drawer**: view all attributes, revision history and linked objects of an asset.
- **Create asset** dialog, with optional automatic **asset tags** (see Settings).
- **Batch update**: change an attribute across multiple selected rows at once.
- **Column drawer**: show, hide and reorder columns; preferences persist.
- **Search and filtering**: global quick search, an attribute filter builder, and a raw **AQL** (Assets Query Language) input. AQL filters can be saved as named presets.
- **Status colour-coding**: status values render as badges whose colours you can map per status name.

### Dashboard
Total object count plus a per-status breakdown for the selected object type. Clicking a status jumps to the grid filtered to that status.

### Quick Scan
Built for handheld barcode/QR scanners. Scan or type a value and press Enter to look up the matching asset and apply a pre-configured set of changes immediately.
- Choose which attribute to match against (Key or any text attribute).
- Define one or more actions (set a field to a value, clear it, or set a date/time to "now").
- Save and reuse action sets as presets (for example "Return to stock").
- Per-scan result log showing updated, unchanged and failed scans, with optional audio feedback.

### Label templates and printing
- **Visual designer** with drag/resize handles and snapping.
- Units in mm, inches or px; single-label or sheet layouts (A3/A4/A5 grids) and continuous label sizes.
- Rich text elements with placeholders bound to asset attributes (for example `${Key}`, `${Name}`, `${Serial Number}`).
- **Code 128** and **QR code** elements, rendered as vector SVG for sharp output on 300/600 DPI printers.
- Create, duplicate, rename, edit and delete templates; mark one as the default.
- Select rows in the grid and use the sticky action bar to print with the default template, or pick another from the split menu. Output is a PDF that is saved to disk or opened in the system viewer.

### Settings
- **Connection**: Atlassian site URL, account email and API token. The token is stored in the OS credential vault (Keychain, Credential Manager, Secret Service) and is never exposed to the web UI.
- **Network**: optional proxy URL, option to accept invalid certificates, and a "web proxy sign-in" flow for networks where a filter (for example Zscaler) requires a browser login first.
- **Schema**: pick the primary schema and object type.
- **Asset tag**: per-object-type template (for example `SSCCXXXXX`) that auto-generates the next zero-padded tag.
- **Status colours**: map status names to colours.
- **Label defaults**: default template, unit, label size and print action.
- **Backup**: export and import settings to a JSON file, with optional passphrase encryption (Argon2-derived key). Connection details are only included in, and restored from, encrypted exports.
- **Updates**: built-in updater with stable and nightly channels.

### Other
- Frameless custom title bar with native window controls.
- Light and dark themes (follows the system by default).
- Keyboard shortcuts: `Ctrl/Cmd + F` focuses search, `Ctrl/Cmd + ,` opens Settings, `Esc` dismisses dialogs or cancels a cell edit.

## Requirements

JAM talks to the **Jira Assets REST API on Atlassian Cloud**, so you need:

- An Atlassian Cloud site with Jira Service Management Assets enabled.
- An [Atlassian API token](https://id.atlassian.com/manage/api-tokens) for an account that can access the assets workspace.

### Assumptions about your Assets schema

> [!CAUTION]
> **JAM is NOT a general-purpose Jira Assets client. It only fits schemas laid out as described below.**

JAM was built around one specific setup and **may not suit yours**. It assumes a single schema (for example "XYZ Enterprises Assets") where **each branch is its own object type**, and every one of those object types shares the same set of common attributes such as `Asset Tag`, `CPU` and `Model`. The app works on one schema and one object type at a time, so you switch between branches by changing the primary object type.

```
XYZ Enterprises Assets          <- schema
├── Branch A                    <- object type (attributes: Asset Tag, CPU, Model, ...)
├── Branch B                    <- object type (same attributes)
└── Branch C                    <- object type (same attributes)
```

**If your schema is instead organised by kind of asset**, with object types such as `Software`, `Laptop`, `Desktop` or `Mobile Device` under a general "Assets" schema, **JAM may not work for you.** Features such as the asset tag template, Quick Scan lookups, batch updates and label placeholders are all configured per object type and assume attributes are consistent within it.

Treat it as a starting point and expect to adapt the code to your own schema layout.

## Installation

Download the installer for your platform from the project's GitHub Releases page:

| Platform | Artifact |
| --- | --- |
| macOS (Apple Silicon) | `.dmg` |
| Windows | NSIS `.exe` installer |
| Linux | `.AppImage` |

Nightly builds are available through the in-app update channel selector (Settings → Updates).

> Builds are not code-signed or notarised. macOS and Windows may show a security warning on first launch.

### macOS: clearing the quarantine flag

Because the app is not notarised, macOS may report it as "damaged" or block it from opening. After dragging `JAM.app` to `/Applications`, clear its quarantine attribute:

```sh
xattr -cr /Applications/JAM.app
```

Replace `/Applications/JAM.app` with the actual path to `JAM.app` if you installed it elsewhere.

## Usage

1. Open **Settings → Connection** and enter your site URL (`https://your-site.atlassian.net`), account email and API token, then click **Connect**.
2. Open **Settings → Schema** and choose the primary schema and object type.
3. Optional: configure **Asset tag**, **Status colours** and **Label defaults**.
4. Use **Dashboard** for an overview, **Assets** to browse and edit, **Quick Scan** for scanner workflows, and **Templates** to design labels.
5. To print labels, tick rows in the Assets grid and use **Print X Labels** in the action bar.

## Building for development

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- Platform dependencies for [Tauri 2](https://tauri.app/start/prerequisites/):
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Microsoft C++ Build Tools and WebView2
  - **Linux** (Debian/Ubuntu):
    ```sh
    sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libdbus-1-dev pkg-config libssl-dev
    ```

### Run

```sh
git clone https://github.com/mclarence/JAM.git
cd JAM
pnpm install

# Full desktop app with hot reload
pnpm tauri dev

# Frontend only (browser, no native features) on http://localhost:1420
pnpm dev
```

### Checks and production build

```sh
pnpm typecheck                 # TypeScript
(cd src-tauri && cargo check)  # Rust

pnpm tauri build               # installers in src-tauri/target/release/bundle
```

### Updater signing

Release builds are signed for the auto-updater. Generate your own key pair and replace `plugins.updater.pubkey` in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json):

```sh
pnpm tauri signer generate
```

## Project structure

```
src/            React + TypeScript frontend
  api/          Jira Assets API client, types and TanStack Query hooks
  components/   assets grid, label designer, quick scan, settings, UI primitives
  lib/          AQL helpers, asset tags, batch update, quick scan logic
  pages/        Dashboard, Assets, Quick Scan, Templates, Settings
  store/        Zustand stores (settings, templates, theme, updater, ...)
src-tauri/      Rust host: credential storage, HTTP/proxy, backup crypto, PDF files, updater
docs/           Jira Assets API spec and auth reference notes
.github/        Release and nightly CI workflows
```

## Tech stack

Tauri 2 (Rust), React 19, TypeScript, Vite, Tailwind CSS 4, Radix UI, TanStack Query / Table / Virtual, Zustand, bwip-js, jsPDF.

## License

Released under the [GNU General Public License v3.0](LICENSE).
