# JAM settings sync protocol — version 1

This document is the normative description of end-to-end encrypted settings sync shared by the JAM desktop app (Tauri) and the JAM iOS app. It is copied byte-for-byte into both repositories; future clients (for example Android) must implement it exactly.

Reference implementations:

| Part | Desktop | iOS |
| --- | --- | --- |
| Crypto | `src-tauri/src/sync_crypto.rs` | `Packages/JAMKit/Sources/JAMKit/Sync/SyncCrypto.swift` |
| Merge engine | `src/lib/sync/engine.ts` | `Packages/JAMKit/Sources/JAMKit/Sync/SyncEngine.swift` |
| Shared fixtures | `fixtures/sync/*.json` | `fixtures/sync/*.json` (identical) |

## 1. Threat model and scope

- The storage provider (Google Drive `appDataFolder`) sees only ciphertext, file names made of random identifiers, sizes, and access timing. Setting names, values, and causal metadata are encrypted.
- Jira API tokens/keys, OAuth credentials, the sync password, sync keys, proxy settings, TLS-bypass options, printer/file destinations, window/navigation state, and cached Jira data **never** sync.
- A compromised unlocked device can read the vault. Disconnect/reset cannot erase data already downloaded by another device.
- AEAD does not prove freshness. Clients keep known history locally and report missing history for their own generation (§5), but a fresh install cannot detect a malicious rollback.

## 2. Platform scopes

Every record belongs to exactly one scope (1–16 lowercase ASCII letters):

| Scope | Synced between | Contents |
| --- | --- | --- |
| `shared` | every device | features available on all platforms |
| `desktop` | desktop devices only | label templates/defaults, column widths, updater settings |
| `ios` | iOS devices only | reserved; unused in v1 |

A device requests, downloads, decrypts, stores, validates, and reports only scopes it syncs (desktop: `shared`+`desktop`; iOS: `shared`). Records of other scopes are ignored entirely: they never produce errors, conflicts, or pending status, and a device never writes another platform's scope. The scope is part of the file name (so it can be filtered before download) and is authenticated in the AAD (so it cannot be relabelled).

A feature moves into `shared` only when every platform supports it and a new protocol revision defines its mapping.

## 3. Cryptography

Primitives are libsodium-compatible: Argon2id v1.3 and XChaCha20-Poly1305-IETF (24-byte nonce, 16-byte tag appended to the ciphertext). Binary values are standard Base64 with padding. Identifiers (generation, batch, version, device IDs) are 32 lowercase hex characters (16 random bytes).

### 3.1 Password

- Encoded as UTF-8 exactly as entered: no trimming, no Unicode normalization.
- New passwords need at least 8 Unicode scalar values; at most 1024 UTF-8 bytes.

### 3.2 Vault descriptor

One per generation. File name `jam-sync-v1-vault-<generationId>.json`:

```json
{
  "format": "jam-sync-vault",
  "version": 1,
  "generationId": "<id>",
  "createdAt": "<RFC 3339>",
  "kdf": { "alg": "argon2id13", "memKiB": 65536, "iterations": 3, "parallelism": 1, "salt": "<16 bytes>" },
  "wrap": { "nonce": "<24 bytes>", "ciphertext": "<32-byte data key + tag>" }
}
```

- Wrapping key = Argon2id(password, salt, memKiB, iterations, parallelism) → 32 bytes.
- `wrap` = XChaCha20-Poly1305(wrapping key, nonce, data key, AAD `jam-sync:v1:vault-key:<generationId>`).
- Readers accept `memKiB` 8192–262144, `iterations` 1–10, `parallelism` exactly 1, and reject anything else **before** running the KDF.
- Authentication failure means "wrong password".

### 3.3 Batch envelope

File name `jam-sync-v1-batch-<generationId>-<scope>-<batchId>.json`:

```json
{
  "format": "jam-sync-batch",
  "version": 1,
  "generationId": "<id>",
  "scope": "shared",
  "batchId": "<id>",
  "nonce": "<24 bytes>",
  "ciphertext": "<...>"
}
```

Encrypted with the data key and AAD `jam-sync:v1:batch:<generationId>:<scope>:<batchId>`. Envelope and plaintext are each limited to 4 MiB; larger inputs are rejected before decoding/decrypting.

### 3.4 Versioning

`format` must match exactly. A `version` greater than the client supports fails with: *"The sync data was created by a newer version of the app. Update this app to continue syncing."* Nothing is applied and nothing is uploaded until the app is updated.

## 4. Change batches

Decrypted batch plaintext:

```json
{
  "format": "jam-sync-changes",
  "version": 1,
  "deviceId": "<id>",
  "platform": "desktop",
  "createdAt": "<RFC 3339>",
  "records": [
    { "key": "theme", "versionId": "<id>", "parents": ["<id>"], "deleted": false, "value": "dark" }
  ]
}
```

- A record ID is `<scope>|<key>`. Each record version is immutable and identified by `versionId`; `parents` lists the versions it supersedes.
- `deleted: true` is a tombstone and must have no `value`. `deleted: false` must have a `value` (JSON `null` is a valid value, distinct from deletion).
- Limits: ≤ 5000 records per batch, key ≤ 512 characters, ≤ 64 parents, JSON nesting ≤ 32 arrays/objects, finite numbers only. Writers split local changes per scope into batches of about 1 MiB.
- A batch that fails any check is rejected as a whole and reported; it is never partially applied.
- Unknown fields in a record value are preserved by adapters that do not understand them.

## 5. Engine

Each device keeps encrypted local state: known batch IDs, the version graph per record, the last synced value (`snapshot`) and parents per record, pending batches, and whether the first merge has been confirmed.

1. **Capture**: for each managed record whose current local value differs from `snapshot`, create a new version whose parents are the record's local parents, and queue it in a pending batch. Pending batches are persisted before upload and re-uploaded idempotently by `batchId`.
2. **Pull**: list batch files for this generation and synced scopes, download unknown ones, decrypt, validate, and add their versions to the graph. If this device's vault descriptor is missing or a newer generation exists, the vault is *stale*: stop, and ask the user to re-enroll. Pending edits are not published into a replacement vault.
3. **Plan** per record (skipping records edited locally since capture):
   - heads = versions not referenced as a parent by another version.
   - heads equal to the local parents → nothing to do.
   - all heads carry equal content (same deletion state and deep-equal JSON) → apply it; local parents become all heads.
   - otherwise → **conflict**. The record keeps its last applied local value and shows an indicator; other records keep syncing.
4. **Apply** changes through the platform adapter, persist the stores, then commit snapshots/parents. An adapter may *defer* a change (e.g. the connection identity differs, or a Quick Scan session is active) — it is retried on the next run — or mark it *invalid*.
5. **Resolve**: the user picks a value (or deletion); a new version whose parents are all heads is queued. Some records (connection, selection) resolve automatically in favour of the local value.
6. **Push** pending batches.

Ordering is by ancestry only; device clocks are never compared. History and tombstones are kept for the life of a generation.

### First merge

Before first sync, users confirm this device's category checklist and review differences for the selected categories. Nothing in a newly enabled category is uploaded or applied until review is confirmed. Missing local values versus existing remote values are explicit choices, not automatic deletions. The core engine's first-merge preview remains available for clients without the category-selection UI.

### Device-local category policy

Category choices are local preferences, not wire records. A missing, invalid or unsupported preferences file gates sync until explicit confirmation, including existing enrolled devices upgrading to this feature. An explicitly empty selection pauses settings sync without deleting settings or signing out. The local preference file stores version 1, selected categories, approved active categories, and the generation to which that approval belongs. A different vault generation requires review again; choices themselves survive sign-out/reset.

`fixtures/sync/categories.json` maps record kinds to stable categories. Connection, selection, theme, filters, columns, asset tags, reference display, status colours, rules, deletions and Quick Scan are shared categories. Rule and ruleOrder are grouped, as are scanConfig/scanPreset/scanSound. Desktop columnSizes belongs to columns. Desktop template/defaultTemplate/labelDefaults belong to labels; updater belongs to updater; reportSource/report belong to reports. iOS offers none of labels, updater or reports, and never downloads desktop-scoped batches. The reports category is off until the user selects it: existing installs keep their confirmed selection, which does not include it.

Apply the policy to projection, management, capture, incoming application, previews/conflicts, suggestions, conflict resolution and every pending-upload path. Exclusion leaves local values and cloud records unchanged; absence from the filtered projection must not generate a deletion. Settings in an existing mixed-category encrypted file can still be downloaded/decrypted into local history. This is application/upload filtering, not a cloud erasure or no-download guarantee.

Pending excluded work is parked durably without blocking enabled work. New captures group batches by category within each existing platform scope. Split legacy mixed pending batches into fresh IDs, retaining record version IDs and parents: never change content under an existing batch ID, including after a lost upload acknowledgement. Other clients can ingest duplicate record versions idempotently.

Newly selected categories stay inactive until review succeeds. Build review from current local values and a fresh cloud-only graph, not parked unpublished local versions. Include local-only, remote-only, deletion and multi-head cases. Each differing record requires an explicit local or synced choice. Verify both local values and cloud heads again before committing; stale previews must be refreshed. Resolve reviewed values with all known heads as parents, supersede obsolete parked work, persist the gated engine state, apply/flush local stores, then durably approve the categories. Interrupted or failed commits remain gated; cancelling does not apply or publish staged choices. Unaffected approved categories retain their policy during review.

Synced connection details remain suggestions, never automatic credential changes. Keeping a local connection snapshot after deferring the connection write avoids immediately republishing a local connection over the user's reviewed synced choice. A verified local Jira connection can still supply workspace identity when connection-details sync is unchecked.

Category changes are serialized with runs and scheduled timers are cancelled. Previously accepted/in-flight uploads cannot be recalled. Old clients without category filtering continue syncing their supported settings; category selection does not change encryption, scopes, batch schema or protocol version.

### Scheduling

- Local edits trigger a sync after a 3-second debounce.
- While in the foreground, sync every 5 minutes and on becoming active/focused.
- Sync runs are serialized; edits made during a run are captured by the next run.
- HTTP 429/5xx are retried up to 3 times with jittered exponential backoff.

## 6. Record catalogue

Key parts are joined with `:`, each encoded with `encodeURIComponent` semantics (unreserved: `A–Z a–z 0–9 - _ . ! ~ * ' ( )`). `<c>:<w>:<type>` means cloud ID, workspace ID, object-type ID. Workspace-keyed records are managed only for the currently connected workspace; records for other workspaces are retained but not applied.

"Absent" means the record does not exist (deleted), and the local default applies.

### `shared`

| Key | Value |
| --- | --- |
| `connection` | `{siteUrl, email, cloudId, workspaceId}` — no token. Applied only when it matches the local verified identity; otherwise offered as a suggestion. Auto-resolves to local. |
| `selection` | `{cloudId, workspaceId, schemaId, objectTypeId}` — deferred while the workspace differs or a scan is active. Auto-resolves to local. |
| `theme` | `"light"` or `"dark"`; system theme is absent. |
| `filter:<id>` | `{name, aql}` |
| `filterOrder` | `[filterId]`; unique string IDs in global chip order. Apply after filter records; retain listed local presets in remote order, then append unlisted local presets in their existing order. Unknown IDs do not create presets. |
| `columns:<c>:<w>:<type>` | `{hidden: [attrId], order?: [attrId]}` |
| `assetTag:<c>:<w>:<type>` | asset-tag configuration |
| `referenceDisplay:<c>:<w>:<type>` | reference display field configuration |
| `statusColor:<name>` | colour differing from the default; `null` = default colour removed; absent = default |
| `rule:<id>` | automation rule; every action has `mode`, `value` only when `mode` is `set` |
| `ruleOrder:<c>:<w>:<type>` | `[ruleId]`; on apply, remote order filtered to local rules, then local rules not listed |
| `deletion:<c>:<w>:<type>` | `{method, marker?: {attributeId, attributeName?, value: {raw, display, referenceId?}}, additional?}` |
| `scanConfig:<c>:<w>:<type>` | `{lookups, actions, presetId?}`; default `{lookups:["__key__"], actions:[]}` is absent |
| `scanPreset:<c>:<w>:<type>:<id>` | `{name, lookups, actions}` |
| `scanSound` | `false`; enabled is absent |

`filterOrder` belongs to the filters category alongside `filter`. Local preset arrays persist display order without a settings-schema change. Projection preserves the last order snapshot when the relative order of IDs common to the snapshot and local presets is unchanged; additions/deletions alone do not overwrite remote order. Fresh empty defaults without a snapshot omit this record. Removing the order record does not force a local reorder. Malformed arrays and duplicate IDs are rejected without mutating presets. Simultaneous reorders use the existing sync conflict review.

This is an additive record: older clients leave it unmanaged and continue syncing individual filters without their order. Clients receiving no order retain existing insertion order; a newer client's first order record uses its current local array. No encryption, batch schema or protocol-version change is required.

### `desktop`

| Key | Value |
| --- | --- |
| `template:<id>` | complete label template including `updatedAt` |
| `defaultTemplate` | template ID |
| `labelDefaults` | `{unit, width, height}`; default `{mm, 62, 29}` is absent; PDF output mode is device-local |
| `columnSizes:<c>:<w>:<type>` | `{attrId: width}` |
| `updater` | `{channel, autoCheck}`; default `{stable, true}` is absent |
| `reportSource:<c>:<w>:<id>` | `{name, objectTypeIds, scopeAql, attributeAliases: {attrId: [oldName]}, updatedAt}`; collected data and name matches are device-local and never synced |
| `report:<c>:<w>:<id>` | `{name, sourceId, spec, view, updatedAt}`; `spec` is the query without soft-delete markers (derived from `deletion` on each run); results are never synced. A report whose source is missing stays until removed |

## 7. Storage provider: Google Drive

- OAuth 2.0 authorization code flow with PKCE (S256) and `state` verification, scopes `https://www.googleapis.com/auth/drive.appdata openid email`. Desktop uses a loopback redirect on `127.0.0.1`; iOS uses `ASWebAuthenticationSession` with its registered URL scheme. Installed clients are public; no client secret is required for security.
- Files live in the hidden `appDataFolder`, invisible to the user and other apps. Desktop and iOS OAuth clients must belong to the same Google Cloud project to share it.
- One vault per Google account. Files are immutable: written once by multipart upload, never modified. Reset creates a new generation and permanently deletes the old generation's files (reporting partial failures).
- Drive file names are not unique; clients deduplicate by `batchId`. If several vault descriptors exist for the latest timestamp, the user picks one.

## 8. Fixtures

- `crypto-vectors.json`: deterministic vault/batch envelopes; implementations must reproduce them byte-for-byte and decrypt them.
- `engine-scenarios.json`: multi-device desktop/iOS scenarios (merge, conflicts, tombstones, platform isolation, malformed and newer-version batches, crash recovery). Every engine runs them all.
- `categories.json`: shared TypeScript/Swift record-kind/category mapping, including desktop-only kinds.
