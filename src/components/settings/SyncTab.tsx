import { useState } from "react";
import { AlertTriangle, CloudOff, KeyRound, Loader2, LogOut, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Card, Label } from "@/components/ui/primitives";
import { notify } from "@/lib/notify";
import { describeRecord, summarizeValue } from "@/lib/sync/labels";
import { syncActions, useSync, type ConflictView } from "@/store/sync";

const MIN_PASSWORD = 8;

function passwordError(pass: string, confirm: string) {
  if ([...pass].length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pass !== confirm) return "The passwords do not match.";
  return null;
}

function PasswordForm({ mode, submitLabel, onSubmit }: { mode: "create" | "unlock"; submitLabel: string; onSubmit: (password: string) => Promise<unknown> }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [working, setWorking] = useState(false);
  const error = mode === "create" ? passwordError(pass, confirm) : pass ? null : "Enter the sync password.";

  const submit = async () => {
    setWorking(true);
    try {
      await onSubmit(pass);
      setPass("");
      setConfirm("");
    } catch (e) {
      notify.error(e, mode === "create" ? "Could not set up sync" : "Could not unlock sync");
    } finally {
      setWorking(false);
    }
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) void submit();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="sync-pass">Sync password</Label>
        <Input id="sync-pass" type="password" autoComplete={mode === "create" ? "new-password" : "current-password"} value={pass} onChange={(e) => setPass(e.target.value)} />
      </div>
      {mode === "create" && (
        <div className="grid gap-2">
          <Label htmlFor="sync-pass2">Confirm sync password</Label>
          <Input id="sync-pass2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
      )}
      <p className={error && pass ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {error && pass
          ? error
          : mode === "create"
            ? "This password encrypts your settings before they leave this device. It cannot be recovered: if you forget it, you must reset sync. Use a different password from your Google account."
            : "Enter the sync password you chose on your other device."}
      </p>
      <div>
        <Button type="submit" disabled={working || !!error}>
          {working ? <Loader2 className="animate-spin" /> : <KeyRound />} {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function ConflictRow({ conflict, disabled }: { conflict: ConflictView; disabled: boolean }) {
  const title = describeRecord(conflict.rid, conflict.local, ...conflict.options.map((o) => o.value));
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <p className="font-medium">{title}</p>
      <div className="grid gap-2">
        <ChoiceButton label="Keep this device's version" value={summarizeValue(conflict.local)} disabled={disabled} onClick={() => syncActions.resolve(conflict.rid, conflict.local)} />
        {conflict.options.map((o) => (
          <ChoiceButton key={o.versionId} label="Use the version from another device" value={summarizeValue(o.value)} disabled={disabled} onClick={() => syncActions.resolve(conflict.rid, o.value)} />
        ))}
      </div>
    </div>
  );
}

function ChoiceButton({ label, value, disabled, onClick }: { label: string; value: string; disabled: boolean; onClick: () => Promise<void> }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onClick()}
      className="grid gap-0.5 rounded-md border border-input bg-background px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
    >
      <span>{label}</span>
      <span className="break-all font-mono text-xs text-muted-foreground">{value}</span>
    </button>
  );
}

function Scope() {
  return (
    <Card className="grid gap-2 p-4 text-sm">
      <p className="font-medium">What syncs</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>
          With all your devices (desktop and iOS): site URL and email, selected schema and object type, theme, saved filters, status
          colours, columns, asset tags, reference fields, Rules, deletion settings and Quick Scan settings.
        </li>
        <li>With your other computers only: label templates, label defaults, column widths and update settings.</li>
        <li>Never: your Jira API token. Enter it on each device.</li>
      </ul>
      <p className="text-xs text-muted-foreground">
        Settings are end-to-end encrypted with your sync password and stored in this app's private Google Drive folder. Google cannot
        read them.
      </p>
    </Card>
  );
}

export function SyncTab() {
  const s = useSync();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const run = (action: () => Promise<unknown>, title: string) => () =>
    void action().catch((e) => notify.error(e, title));

  const account = s.status?.email && (
    <p className="text-sm text-muted-foreground">
      Signed in to Google as <span className="font-medium text-foreground">{s.status.email}</span>
    </p>
  );

  let body: React.ReactNode;
  switch (s.phase) {
    case "loading":
      body = (
        <p className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading sync status
        </p>
      );
      break;
    case "unavailable":
      body = (
        <Card className="flex items-start gap-3 p-4 text-sm">
          <CloudOff className="mt-0.5 size-4 shrink-0" />
          <p>Settings sync is not available in this build. It needs the desktop app built with a Google OAuth client ID.</p>
        </Card>
      );
      break;
    case "signedOut":
      body = (
        <Card className="grid gap-3 p-4 text-sm">
          <p>Sign in with Google to sync settings between your devices. Your browser opens to complete sign-in.</p>
          <div className="flex gap-2">
            <Button disabled={s.signingIn} onClick={run(syncActions.signIn, "Google sign-in failed")}>
              {s.signingIn && <Loader2 className="animate-spin" />} Sign in with Google
            </Button>
            {s.signingIn && (
              <Button variant="outline" onClick={run(syncActions.cancelSignIn, "Could not cancel sign-in")}>
                Cancel
              </Button>
            )}
          </div>
        </Card>
      );
      break;
    case "locked":
    case "stale":
      body = (
        <Card className="grid gap-4 p-4 text-sm">
          {account}
          {s.phase === "stale" && (
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              Sync was reset on another device. Enter the new sync password to continue.
            </p>
          )}
          {s.vaults.length ? (
            <PasswordForm mode="unlock" submitLabel="Unlock sync" onSubmit={(p) => syncActions.unlockVault(s.vaults[0].generationId, p)} />
          ) : (
            <>
              <p>Choose a sync password. You will enter it once on each device you add.</p>
              <PasswordForm mode="create" submitLabel="Turn on sync" onSubmit={syncActions.createVault} />
            </>
          )}
          {s.phase === "locked" && s.vaults.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Forgot the password?{" "}
              <button type="button" className="underline" onClick={() => setResetOpen(true)}>
                Reset sync
              </button>{" "}
              to start again with this device's settings.
            </p>
          )}
        </Card>
      );
      break;
    case "preview":
      body = (
        <Card className="grid gap-3 p-4 text-sm">
          {account}
          <p className="font-medium">Review the first sync</p>
          <p>This device's settings will be merged with your other devices:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{s.preview?.outgoing ?? 0} setting(s) from this device will be shared.</li>
            <li>{s.preview?.incoming.length ?? 0} setting(s) from other devices will be applied here.</li>
            {!!s.preview?.conflicts.length && <li>{s.preview.conflicts.length} setting(s) differ; you choose which version to keep after merging.</li>}
          </ul>
          {!!s.preview?.incoming.length && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Settings that will change on this device</summary>
              <ul className="mt-1 list-disc pl-5">
                {s.preview.incoming.map((id) => (
                  <li key={id}>{describeRecord(id)}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-2">
            <Button disabled={s.busy} onClick={run(syncActions.confirmMerge, "Sync failed")}>
              {s.busy && <Loader2 className="animate-spin" />} Merge and sync
            </Button>
            <Button variant="outline" disabled={s.busy} onClick={() => setConfirmDisconnect(true)}>
              Don't sync
            </Button>
          </div>
        </Card>
      );
      break;
    case "ready":
      body = (
        <Card className="grid gap-3 p-4 text-sm">
          {account}
          <p className="text-muted-foreground">
            {s.busy ? "Syncing…" : s.lastSyncedAt ? `Last synced ${new Date(s.lastSyncedAt).toLocaleString()}` : "Not synced yet."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={s.busy} onClick={run(syncActions.syncNow, "Sync failed")}>
              {s.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync now
            </Button>
            <Button variant="outline" size="sm" disabled={s.busy} onClick={() => setResetOpen(true)}>
              <RotateCcw /> Reset sync…
            </Button>
          </div>
        </Card>
      );
      break;
  }

  return (
    <div className="grid max-w-2xl gap-6">
      <Scope />
      {body}

      {s.error && (
        <Card className="flex items-start gap-2 border-destructive/50 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {s.error}
        </Card>
      )}
      {s.warnings.length > 0 && (
        <Card className="grid gap-1 p-4 text-sm">
          {s.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" /> {w}
            </p>
          ))}
        </Card>
      )}
      {s.suggestedConnection && (
        <Card className="p-4 text-sm">
          Your other devices use <span className="font-medium">{s.suggestedConnection.siteUrl}</span> as{" "}
          <span className="font-medium">{s.suggestedConnection.email}</span>. To sync workspace settings, connect to the same site in
          API Connection with your API token.
        </Card>
      )}
      {s.phase === "ready" && s.conflicts.length > 0 && (
        <div className="grid gap-3">
          <p className="text-sm font-medium">Choose which version to keep</p>
          {s.conflicts.map((c) => (
            <ConflictRow key={c.rid} conflict={c} disabled={s.busy} />
          ))}
        </div>
      )}

      {s.status?.signedIn && (
        <div>
          <Button variant="ghost" size="sm" disabled={s.busy} onClick={() => setConfirmDisconnect(true)}>
            <LogOut /> Turn off sync on this device
          </Button>
        </div>
      )}

      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off sync on this device?</DialogTitle>
            <DialogDescription>
              This device signs out of Google and stops syncing. Its settings stay as they are, and your other devices keep syncing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDisconnect(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDisconnect(false);
                run(syncActions.disconnect, "Could not turn off sync")();
              }}
            >
              Turn off sync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset sync</DialogTitle>
            <DialogDescription>
              Deletes all synced settings from Google Drive and starts again with this device's settings and a new password. Every other
              device must then enter the new password, and changes they have not yet synced will be lost.
            </DialogDescription>
          </DialogHeader>
          <PasswordForm
            mode="create"
            submitLabel="Reset sync"
            onSubmit={async (p) => {
              const failures = await syncActions.reset(p);
              setResetOpen(false);
              if (failures) notify.info(`Sync was reset, but ${failures} old file(s) could not be deleted from Google Drive.`);
              else notify.success("Sync was reset.");
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
