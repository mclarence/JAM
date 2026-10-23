import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, KeyRound, Loader2, ShieldCheck, Upload } from "lucide-react";
import { ApiError, backupApi, type ImportPreview } from "@/api/client";
import { qk, useConnection } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Card, Checkbox, Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";
import {
  SECTION_LABELS,
  applyImport,
  buildExport,
  parseImport,
  sectionCounts,
  type ImportMode,
  type Section,
  type SettingsBundle,
} from "@/lib/settingsTransfer";

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];
const MIN_PASSPHRASE = 8;

interface PendingImport {
  path: string;
  passphrase?: string;
  bundle: SettingsBundle;
  connection: ImportPreview["connection"];
  fileName: string;
}

export function BackupTab() {
  const qc = useQueryClient();
  const connection = useConnection();
  const connected = !!connection.data;

  const [busy, setBusy] = useState(false);

  // Export dialog
  const [exportOpen, setExportOpen] = useState(false);
  const [includeConnection, setIncludeConnection] = useState(false);
  const [encrypt, setEncrypt] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");

  // Import flow
  const [askPass, setAskPass] = useState<{ path: string; error?: string } | null>(null);
  const [importPass, setImportPass] = useState("");
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [sections, setSections] = useState<Set<Section>>(new Set());
  const [importConn, setImportConn] = useState(true);
  const [mode, setMode] = useState<ImportMode>("merge");

  const mustEncrypt = includeConnection;
  const encrypting = encrypt || mustEncrypt;
  const passError = !encrypting
    ? null
    : pass.length < MIN_PASSPHRASE
      ? `Use at least ${MIN_PASSPHRASE} characters.`
      : pass !== pass2
        ? "The passphrases do not match."
        : null;

  const openExport = () => {
    setIncludeConnection(false);
    setEncrypt(false);
    setPass("");
    setPass2("");
    setExportOpen(true);
  };

  const exportSettings = async () => {
    if (passError) return;
    setBusy(true);
    try {
      const path = await save({
        defaultPath: `jira-assets-manager-settings-${new Date().toISOString().slice(0, 10)}.json`,
        filters: JSON_FILTER,
      });
      if (!path) return;
      await backupApi.export({
        path,
        settings: buildExport(),
        includeConnection,
        passphrase: encrypting ? pass : undefined,
      });
      setExportOpen(false);
      setPass("");
      setPass2("");
      notify.success(encrypting ? "Encrypted settings exported" : "Settings exported");
    } catch (e) {
      notify.error(e, "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (path: string, passphrase?: string) => {
    try {
      const preview = await backupApi.read(path, passphrase);
      const bundle = parseImport(preview.settings);
      setAskPass(null);
      setImportPass("");
      setSections(new Set(Object.keys(sectionCounts(bundle)) as Section[]));
      setImportConn(!!preview.connection);
      setMode("merge");
      setPending({
        path,
        passphrase,
        bundle,
        connection: preview.connection,
        fileName: path.split(/[\\/]/).pop() ?? path,
      });
    } catch (e) {
      if (e instanceof ApiError && e.kind === "passphraseRequired") {
        setAskPass({ path });
      } else if (e instanceof ApiError && e.kind === "passphraseInvalid") {
        setAskPass({ path, error: e.message });
      } else {
        setAskPass(null);
        notify.error(e, "Import failed");
      }
    }
  };

  const chooseImport = async () => {
    setBusy(true);
    try {
      const path = await open({ multiple: false, directory: false, filters: JSON_FILTER });
      if (!path || Array.isArray(path)) return;
      setImportPass("");
      await readFile(path);
    } catch (e) {
      notify.error(e, "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const submitPassphrase = async () => {
    if (!askPass || !importPass) return;
    setBusy(true);
    try {
      await readFile(askPass.path, importPass);
    } finally {
      setBusy(false);
    }
  };

  const closeImport = () => {
    setPending(null);
    setImportPass("");
  };

  const confirmImport = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      // Connection first: if it fails nothing else has been changed.
      if (importConn && pending.connection) {
        const info = await backupApi.importConnection(pending.path, pending.passphrase);
        qc.setQueryData(qk.connection, info);
        qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "connection" });
      }
      applyImport(pending.bundle, sections, mode);
      notify.success("Settings imported");
      closeImport();
    } catch (e) {
      notify.error(e, "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const counts = pending ? sectionCounts(pending.bundle) : {};
  const toggle = (s: Section, on: boolean) =>
    setSections((prev) => {
      const next = new Set(prev);
      if (on) next.add(s);
      else next.delete(s);
      return next;
    });

  return (
    <div className="grid max-w-2xl gap-6">
      <Card className="flex items-start gap-3 p-4 text-sm">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-green-600 dark:text-green-400" />
        <p className="text-muted-foreground">
          Exports include saved filters, column layouts, asset tag numbering, status colours, Quick Scan presets, label templates and
          preferences. Your API connection (site, email and token) is only included if you choose to, and then the
          whole file is encrypted with a passphrase. Network and proxy options are never exported.
        </p>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button onClick={openExport} disabled={busy}>
          <Download /> Export settings…
        </Button>
        <Button variant="outline" onClick={chooseImport} disabled={busy}>
          {busy && !exportOpen ? <Loader2 className="animate-spin" /> : <Upload />} Import settings…
        </Button>
      </div>

      <Dialog open={exportOpen} onOpenChange={(o) => !busy && setExportOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export settings</DialogTitle>
            <DialogDescription>Choose what to include and whether to protect the file.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void exportSettings();
            }}
          >
            <Label className="flex cursor-pointer items-start gap-3 font-normal">
              <Checkbox
                className="mt-0.5"
                checked={includeConnection}
                disabled={!connected}
                onCheckedChange={(v) => setIncludeConnection(!!v)}
              />
              <span>
                Include API connection settings
                <span className="block text-xs text-muted-foreground">
                  {connected
                    ? `Site ${connection.data!.siteUrl}, account email and API token. Requires encryption.`
                    : "Not available: no API connection is configured."}
                </span>
              </span>
            </Label>

            <Label className="flex cursor-pointer items-start gap-3 font-normal">
              <Checkbox
                className="mt-0.5"
                checked={encrypting}
                disabled={mustEncrypt}
                onCheckedChange={(v) => setEncrypt(!!v)}
              />
              <span>
                Encrypt the file with a passphrase
                <span className="block text-xs text-muted-foreground">
                  {mustEncrypt
                    ? "Required because the API connection is included. Every setting in the file is encrypted."
                    : "Optional. The whole file is encrypted and needs the passphrase to import."}
                </span>
              </span>
            </Label>

            {encrypting && (
              <div className="grid gap-3 rounded-md border p-3">
                <div className="grid gap-2">
                  <Label htmlFor="export-pass">Passphrase</Label>
                  <Input
                    id="export-pass"
                    type="password"
                    autoComplete="new-password"
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="export-pass2">Confirm passphrase</Label>
                  <Input
                    id="export-pass2"
                    type="password"
                    autoComplete="new-password"
                    value={pass2}
                    onChange={(e) => setPass2(e.target.value)}
                  />
                </div>
                <p className={passError && pass ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  {passError && pass
                    ? passError
                    : "The passphrase cannot be recovered. If you lose it, the file cannot be opened."}
                </p>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setExportOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !!passError}>
                {busy ? <Loader2 className="animate-spin" /> : encrypting ? <KeyRound /> : <Download />} Export…
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!askPass} onOpenChange={(o) => !o && !busy && setAskPass(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Encrypted file</DialogTitle>
            <DialogDescription>Enter the passphrase this file was exported with.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitPassphrase();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="import-pass">Passphrase</Label>
              <Input
                id="import-pass"
                type="password"
                autoFocus
                autoComplete="off"
                value={importPass}
                onChange={(e) => setImportPass(e.target.value)}
              />
              {askPass?.error && <p className="text-xs text-destructive">{askPass.error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setAskPass(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !importPass}>
                {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Decrypt
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pending} onOpenChange={(o) => !o && !busy && closeImport()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import settings</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <p className="truncate text-sm text-muted-foreground">{pending?.fileName}</p>
            <div className="grid gap-1">
              {pending?.connection && (
                <Label className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 font-normal hover:bg-accent">
                  <Checkbox className="mt-0.5" checked={importConn} onCheckedChange={(v) => setImportConn(!!v)} />
                  <span className="min-w-0 flex-1">
                    API connection (replaces your current connection)
                    <span className="block truncate text-xs text-muted-foreground">
                      {pending.connection.siteUrl}
                      {pending.connection.email ? ` · ${pending.connection.email}` : ""}
                    </span>
                  </span>
                </Label>
              )}
              {(Object.keys(counts) as Section[]).map((s) => (
                <Label key={s} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 font-normal hover:bg-accent">
                  <Checkbox checked={sections.has(s)} onCheckedChange={(v) => toggle(s, !!v)} />
                  <span className="flex-1">{SECTION_LABELS[s]}</span>
                  {s !== "preferences" && <span className="text-xs text-muted-foreground">{counts[s]}</span>}
                </Label>
              ))}
            </div>
            <div className="grid gap-2">
              <Label>If items already exist</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as ImportMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="merge">Merge: keep existing items, overwrite ones with the same ID</SelectItem>
                  <SelectItem value="replace">Replace: discard existing items in the selected sections</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={closeImport}>
              Cancel
            </Button>
            <Button onClick={confirmImport} disabled={busy || (sections.size === 0 && !(importConn && pending?.connection))}>
              {busy && <Loader2 className="animate-spin" />} Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
