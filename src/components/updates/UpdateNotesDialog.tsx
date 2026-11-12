import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUpdater } from "@/store/updater";
import { ReleaseNotes } from "./ReleaseNotes";

export function UpdateNotesDialog() {
  const { notesDialog, available, pendingInstall, status, progress, error, dismissingNotes, dismissNotes, install } = useUpdater();
  const installed = notesDialog === "installed";
  const release = installed ? pendingInstall : available;
  if (!notesDialog || !release) return null;
  const percent = progress?.total ? Math.min(100, Math.round(progress.downloaded / progress.total * 100)) : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void dismissNotes(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{installed ? "What's New" : "Update available"} - {release.version}</DialogTitle>
          <DialogDescription>
            {installed ? "Your update is installed. Here's what's changed." : "Review what's changed. The update downloads in the background."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto pr-2">
          <ReleaseNotes notes={release.notes} />
        </div>
        {!installed && (
          <div className="text-sm" aria-live="polite">
            {status === "downloading" && (
              <p className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Downloading update{percent === null ? "..." : `: ${percent}%`}
              </p>
            )}
            {status === "ready" && <p>Downloaded and ready to install.</p>}
            {status === "installing" && <p>Installing update...</p>}
            {error && <p className="text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={dismissingNotes} onClick={() => void dismissNotes()}>{installed ? "Done" : "Later"}</Button>
          {!installed && (
            <Button disabled={status !== "ready"} onClick={() => void install()}>Restart to update</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
