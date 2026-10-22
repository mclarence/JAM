# IT Asset Management System (Tauri + React + Tailwind + Shadcn)

You are an expert full-stack developer specializing in desktop applications built with Tauri, Rust, TypeScript, React, Tailwind CSS, and Shadcn UI. Your task is to build an enterprise-grade, cross-platform IT Asset Management (ITAM) desktop application (supporting Windows, macOS, and Linux) powered by the JIRA Assets (Insight) REST API as its primary data store.

---

## 1. Tech Stack & Architecture Requirements

- **Frontend Framework**: React (TypeScript), Tailwind CSS, Shadcn UI, Lucide React (Icons).
- **Backend / Native Host**: Tauri (Rust) for secure file persistence, native window controls, and print/PDF generation pipeline.
- **State Management**: TanStack Query (React Query) for API caching & mutation handling; Zustand for global UI state (selected schema, column preferences, active filters, draft templates, status color mappings).
- **Table Library**: TanStack Table (v8) for performant virtualized tables, inline cell editing, column visibility toggles, and multi-row selection.
- **Drag-and-Drop / Canvas**: `@dnd-kit` or `react-grid-layout` / `konva` for the label template designer.
- **Barcodes / QR Codes**: `bwip-js` or `react-barcode` / `qrcode.react` for rendering high-DPI Code 128 and QR codes.
- **Styling & Window Frame**:
  - Implement a custom frameless titlebar across Windows and macOS.
  - Hide default OS window frames. Integrate native window action controls (minimize, maximize/restore, close) directly into the app header.

---

## 2. Core Features & Specifications

### A. Authentication & User Configurable Settings
- **Auth Storage**: Securely persist the JIRA REST API base URL and Bearer token / Basic Auth credentials in native secure storage (or encrypted local file via Tauri). Refer to `jira_rest_api_auth.txt` and `jira_rest_api_basic_auth.txt` for auth header formatting.
- **Schema & Object Selection**:
  - On settings save/test connection, fetch available asset schemas via JIRA Assets REST API (refer to `jira_assets_api_spec.json`).
  - Provide interactive Shadcn `Select` dropdowns for:
    1. **Primary Schema**
    2. **Primary Object Type** (populated dynamically based on the active schema).
- **Persistence**: Store settings locally so they persist across application restarts.
- **Dedicated Settings Page/Modal**: A clean tabbed panel handling API Connection, Default Schema/Object Types, Status-to-Colour mappings, and Label Defaults.

### B. Asset Management & Data Grid
- **TanStack Table Implementation**:
  - Render all objects/assets from the selected Schema + Object Type.
  - **Column Customization**: Enable show/hide column drawer with persistence to `localStorage` or app settings file.
  - **Inline Editing**: Double-clicking a grid cell enters edit mode for that specific attribute (text, status dropdown, datepicker, reference picker). Changes trigger an asynchronous API update with immediate optimistic UI updates or error rollbacks.
  - **Detail View Drawer/Modal**: Double-clicking a row header or clicking an "Expand" action opens a full slide-out panel detailing all object attributes, complete revision history, and linked objects.
- **Complex Attribute Handling**:
  - **Object References (e.g., Users/People, Assets)**: Async searchable combo box (`Command` component) with debounced auto-complete searching against JIRA Assets API.
  - **Enumerated / Select Attributes & Status Colour-Coding**:
    - Dynamically fetch valid options/statuses for fields like asset status.
    - Render status values inside Shadcn `Badge` components that are **dynamically colour-coded** based on their state (e.g., green for "Active/In Use", yellow for "In Repair/Maintenance", red for "Decommissioned/Retired", gray for "In Stock"). 
    - Allow users to map specific status strings to custom tailwind color variants in the application settings.
- **Filtering & Search**:
  - **Global Quick Search**: Real-time filtering bar across name/key/attributes.
  - **AQL (Asset Query Language) & Attribute Filters**: Provide an advanced filter builder as well as a raw AQL input box. Allow users to name and save custom AQL filter presets.

### C. Printable Asset Label Generator & Template Designer
- **Visual Canvas Designer**:
  - Canvas with customizable unit dimensions (mm, inches, px) and page layouts (Single Label vs. Grid layout on A3/A4/A5 sheets).
  - Drag-and-drop placeholder elements linked to Asset Attributes (e.g., `${Key}`, `${Name}`, `${Serial Number}`, `${Assignee}`).
  - **Rich Text & Barcode Support**:
    - Rich text field formatting (font size, bold, alignment, line-height).
    - Barcode widgets supporting **QR Code** and **Code 128**, bound to any selected asset attribute (e.g., Asset Key or Serial Number).
  - Resizable and draggable element handles with snapping grid lines.
- **Template Management**: Create, duplicate, edit, rename, and set default label templates.
- **Batch Label Generation & Printing**:
  - Assets table must feature multi-select checkboxes on each row with a header toggle ("Select All").
  - Persistent sticky action bar showing: `[ Print X Labels v ]`
    - Main button prints using the user's default template.
    - Split-dropdown menu allows selecting alternative saved templates on the fly.
  - **Print / PDF Engine**: Render precise CSS `@page` print previews or export high-res PDFs formatted for standard sheet sizes (A3, A4, A5) or continuous thermal label printers.

### D. UX Polish & Hardware Performance
- **Tauri Native Frame**: Apply `data-tauri-drag-region` to the header navigation bar. Wire header control icons directly to Tauri's `appWindow` window actions (`minimize`, `toggleMaximize`, `close`).
- **High-DPI Label Printing**: Generate all barcodes and QR codes using vector SVG format to ensure razor-sharp rendering on 300/600 DPI thermal printers. Enforce exact physical dimensions in CSS (`mm`/`in`) with `@media print` rules removing default browser margins.
- **Debounced API Interactions**: Apply a 300ms debounce across all global search bars, AQL inputs, and object-reference autocomplete fields.
- **Optimistic Table Edits**: Grid mutations must optimistically update local TanStack Query cache, rolling back with a Shadcn error toast on API failure.
- **Keybindings**: Support `Ctrl/Cmd + F` (Focus Search), `Ctrl/Cmd + ,` (Open Settings), and `Esc` (Dismiss modals/cancel cell edit).

---

## UI/UX & Layout Architecture

### 1. App Shell Layout
- **Global Structure**: Implement a fixed, full-screen two-column layout consisting of a left-hand navigation sidebar and a right-hand main content viewport.
- **Top Header Bar**: 
  - Positioned across the top of the application (acting as the custom Tauri drag region with `data-tauri-drag-region`).
  - **Left / Center**: Contains a global quick-search input bar (with `Ctrl/Cmd + F` shortcut trigger).
  - **Right**: Houses window action controls (minimize, maximize/restore, close) integrated seamlessly into the header, along with quick toggles for Dark/Light mode and notifications.
- **Left Sidebar**:
  - Fixed or collapsible width (e.g., 240px).
  - Clean menu navigation items using Lucide React icons (e.g., Dashboard/Overview, Assets Grid, Label Templates, Settings).
  - Active route state styled with subtle background highlighting and border accent lines.
- **Main Content Area**:
  - Fills the remaining right-hand space with a clean, scrollable viewport.
  - Consistent padding (`p-6` or `p-8`) with breadcrumbs or page titles at the top of each view.

### 2. Theming & Dark/Light Mode
- **System & Manual Toggle**: Support both Dark and Light modes out-of-the-box using Tailwind CSS's class-based strategy (`class="dark"` on root HTML/body).
- **Persistent Preference**: Save the user's theme choice in local settings/store so it persists across launches, defaulting to system preference on first launch.
- **Aesthetic Guidance**: 
  - *Light Mode*: Crisp white/zinc-50 backgrounds, zinc-100 card surfaces, zinc-900 text, and subtle borders (`zinc-200`).
  - *Dark Mode*: Deep neutral/zinc-950 or slate-950 backgrounds, zinc-900 card surfaces, zinc-100 text, and subtle dark borders (`zinc-800`).
- **Status Badges & Accent Colors**: Ensure all status badge colour-codings and UI elements maintain high contrast and legibility across both dark and light modes.

### ASCII Structural Blueprint
```text
+-----------------------------------------------------------------------------------+
| [Drag Area / Header]  🔍 Search Assets (Cmd+F)       [-] [□] [X]  [🌙/☀️] [⚙️]  |
+-------------------+---------------------------------------------------------------+
|                   |                                                               |
|  🗂️ Assets        |  # Assets Management                                        |
|  🏷️ Templates     |  Showing 1,240 objects in "IT Hardware" schema                |
|  ⚙️ Settings      |                                                               |
|                   |  +---------------------------------------------------------+  |
|                   |  | Name          | Status        | Serial      | Assignee  |  |
|                   |  |---------------+---------------+-------------+-----------|  |
|                   |  | MacBook Pro   | In Use (Green)| C02G...     | Jane Doe  |  |
|                   |  | Dell Monitor  | In Stock (Blue| DL-992...   | Unassigned|  |
|                   |  +---------------------------------------------------------+  |
|                   |                                                               |
+-------------------+---------------------------------------------------------------+
```

---
## 3. Strict Development Rules

1. **JIRA OpenAPI Compliance**: Strictly consult `jira_assets_api_spec.json`. Do **NOT** use deprecated endpoints or fields.
2. **Error Handling & UX Feedback**: Display global toast notifications (via Shadcn `Toaster`) for network failures, unauthorized tokens, or invalid AQL queries.
3. **Performance**: Utilize list virtualization (`@tanstack/react-virtual`) if asset rows exceed 100 items to guarantee smooth scrolling and fast launch times.
4. **Code Structure**: Modularize code into clean layers: `/src/api` (typed JIRA client), `/src/components/ui` (Shadcn), `/src/components/assets` (Grid/Drawers), `/src/components/labels` (Canvas/Designer), and `/src/store` (Zustand state management).