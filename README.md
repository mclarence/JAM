# JAM — JIRA Assets Manager

A cross-platform desktop app (Windows, macOS, Linux) for managing IT assets stored in **Jira Assets** (formerly Insight). It provides a fast, editable data grid, a quick-scan workflow for barcode scanners, and a visual label designer with batch printing.

> [!WARNING]
> **This project is fully AI-generated ("vibe coded").** The code, configuration and this documentation were produced by an AI assistant with human direction and light review. It has not had a formal security audit or thorough testing. Review the code before using it against production data, and use at your own risk.

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

### Asset CSV export
Use **Export** above the grid or **Export selected** in the selection bar. Choose selected assets or **all matching results across every page**, then visible columns in table order or all available attributes in metadata order (including columns you hid, but excluding Jira-hidden attributes). Selected assets are the default when available; visible columns are the default. No extra Key/Label columns are added.

Export reads fresh asset details without changing the table's selection or loaded pages. References, statuses and users use readable names, while numbers, booleans and ISO dates retain API values. Multiple values share one comma-separated cell. CSV files are UTF-8 with Unicode and multiline support.

Progress and Cancel are available with no fixed row cap. The native save dialog opens only when all requested assets have been read; errors can be retried and no partial file is offered. Changing the query, object type or connection cancels the export. Large exports depend on available memory. This is not a server-side point-in-time snapshot: assets may change while exporting. Export requires the desktop app, like the existing Jira connection.

**Spreadsheet warning:** CSV text is preserved exactly, including values starting with `=`, `+`, `-` or `@`. Spreadsheet applications may interpret these as formulas. Only open trusted exported data.

### Quick Scan
Built for handheld barcode/QR scanners. Scan or type a value and press Enter to look up the matching asset and apply a pre-configured set of changes immediately.
- Choose which attribute to match against (Key or any text attribute).
- Define one or more actions (set a field to a value, clear it, or set a date/time to "now").
- Save and reuse action sets as presets (for example "Return to stock").
- Per-scan result log showing updated, unchanged and failed scans, with optional audio feedback.

### Rules
Rules automatically set attributes as part of saves made in this app. Open **Settings → Rules**, select a schema and object type, then create, edit, enable, disable, delete or reorder rules. Rules are stored locally for the Jira workspace and object type; they do not sync with the iOS app or run for changes made in Jira or another client. Desktop settings exports can include rules.

Each rule selects the operations to run on, the attributes to watch, an **any** or **all** group of conditions, and fixed values to set. New rules run on individual edits, batch updates and Quick Scan; object creation is opt-in. For example, watch **Assigned to Employee**, **Assigned to Student** and **Room**; add an **is set** condition for each using **any**; then set **Status** to **Active**.

At least one watched attribute must actually change in the user's save. Conditions see the existing object with the user's changes applied, including clears. All rules evaluate that same snapshot: actions do not trigger other rules, and later matching rules win if they set the same attribute, even over a manually entered value. Presence conditions can inspect multi-valued and read-only attributes; fixed-value actions target editable single-valued attributes. Creation starts with an empty object, and the create form's required fields must still be supplied manually.

Invalid applicable rules block the affected save with an error; other assets in a batch can still succeed. Following a successful rule-driven save, the grid and open detail are updated automatically from the refreshed object. Filters or pagination may exclude the object from the grid. If the save succeeds but refresh fails, the app warns that the display may be stale and offers a retry; refresh before editing that asset again rather than repeating the save.

Rules are client-side, not server-side automation or an atomic compare-and-set. They have no schedules, scripts, nested condition groups or dynamic action values, and cannot use server defaults when evaluating creation. Concurrent edits from other clients may occur between the app's read and write.

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
- **Rules**: configure ordered, workspace-specific attribute automation.
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
pnpm test                      # Rules and settings tests
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
