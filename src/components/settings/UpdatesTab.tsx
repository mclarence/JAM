import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { Loader2 } from "lucide-react";
import type { UpdateChannel } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, Checkbox, Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUpdater } from "@/store/updater";

function formatMb(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1);
}

export function UpdatesTab() {
  const { channel, autoCheck, status, available, progress, error, lastChecked } = useUpdater();
  const { setChannel, setAutoCheck, checkAndDownload, install } = useUpdater.getState();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (isTauri()) void getVersion().then(setVersion);
  }, []);

  const busy = status === "checking" || status === "downloading";
  const percent = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

  const changeChannel = (value: UpdateChannel) => {
    setChannel(value);
    if (isTauri()) void checkAndDownload();
  };

  return (
    <div className="grid max-w-xl gap-6">
      <Card className="grid gap-1 p-4 text-sm">
        <p className="font-medium">Installed version</p>
        <p className="text-muted-foreground">{version ?? "Unknown (desktop app only)"}</p>
      </Card>

      <div className="grid gap-2">
        <Label>Update channel</Label>
        <Select value={channel} onValueChange={(v) => changeChannel(v as UpdateChannel)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">Stable: tagged releases</SelectItem>
            <SelectItem value="nightly">Nightly: latest build of every commit</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Switching channels installs the newest build from the selected channel, even if it is an older version.
          Nightly builds may be unstable.
        </p>
      </div>

      <Label className="flex cursor-pointer items-start gap-3 font-normal">
        <Checkbox className="mt-0.5" checked={autoCheck} onCheckedChange={(v) => setAutoCheck(!!v)} />
        <span>
          Check for updates automatically
          <span className="block text-xs text-muted-foreground">
            Checks at startup and every few hours. Updates download in the background; you choose when to restart.
          </span>
        </span>
      </Label>

      <Card className="grid gap-3 p-4 text-sm">
        {status === "ready" && available ? (
          <>
            <p>
              Version <span className="font-medium">{available.version}</span> is downloaded and ready to install.
            </p>
            <div>
              <Button size="sm" onClick={() => void install()}>
                Restart to update
              </Button>
            </div>
          </>
        ) : status === "downloading" && available ? (
          <>
            <p className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Downloading {available.version}
              {progress && (
                <span className="text-muted-foreground">
                  {formatMb(progress.downloaded)}
                  {progress.total ? ` / ${formatMb(progress.total)}` : ""} MB
                </span>
              )}
            </p>
            <div className="h-1.5 overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: percent === null ? "100%" : `${percent}%`, opacity: percent === null ? 0.4 : 1 }}
              />
            </div>
          </>
        ) : status === "checking" ? (
          <p className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Checking for updates
          </p>
        ) : status === "error" ? (
          <p className="text-destructive">{error}</p>
        ) : (
          <p className="text-muted-foreground">
            {lastChecked ? "You are up to date." : "No update check has run yet."}
          </p>
        )}
        {lastChecked && <p className="text-xs text-muted-foreground">Last checked {new Date(lastChecked).toLocaleString()}</p>}
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || status === "ready" || !isTauri()}
            onClick={() => void checkAndDownload()}
          >
            Check now
          </Button>
        </div>
      </Card>
    </div>
  );
}
