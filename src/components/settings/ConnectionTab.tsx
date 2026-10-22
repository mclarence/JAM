import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, LogOut, PlugZap } from "lucide-react";
import { connectionApi } from "@/api/client";
import { qk, useConnection } from "@/api/queries";
import type { AuthType } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";

export function ConnectionTab() {
  const qc = useQueryClient();
  const connection = useConnection();
  const [siteUrl, setSiteUrl] = useState("");
  const [authType, setAuthType] = useState<AuthType>("basic");
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");

  useEffect(() => {
    if (connection.data) {
      setSiteUrl(connection.data.siteUrl);
      setAuthType(connection.data.authType);
      setEmail(connection.data.email);
    }
  }, [connection.data]);

  const connect = useMutation({
    mutationFn: () => connectionApi.connect({ siteUrl, authType, email, secret: secret || undefined }),
    onSuccess: (info) => {
      qc.setQueryData(qk.connection, info);
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "connection" });
      setSecret("");
      notify.success("Connected to JIRA Assets");
    },
    onError: (e) => notify.error(e, "Connection failed"),
  });

  const disconnect = useMutation({
    mutationFn: connectionApi.disconnect,
    onSuccess: () => {
      qc.setQueryData(qk.connection, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "connection" });
      notify.info("Disconnected and credentials removed");
    },
    onError: (e) => notify.error(e),
  });

  const connected = !!connection.data;
  const canSubmit = siteUrl.trim() && (authType === "bearer" || email.trim()) && (secret.trim() || connected);

  return (
    <div className="grid max-w-2xl gap-6">
      {connected && (
        <Card className="flex items-center gap-3 p-4">
          <CheckCircle2 className="size-5 text-green-600 dark:text-green-400" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">Connected to {connection.data!.siteUrl}</p>
            <p className="truncate text-muted-foreground">Workspace {connection.data!.workspaceId}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            <LogOut /> Disconnect
          </Button>
        </Card>
      )}

      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) connect.mutate();
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="site">Atlassian site URL</Label>
          <Input
            id="site"
            placeholder="https://your-site.atlassian.net"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label>Authentication</Label>
          <Select value={authType} onValueChange={(v) => setAuthType(v as AuthType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="basic">Basic auth (email + API token)</SelectItem>
              <SelectItem value="bearer">Bearer (OAuth 2.0 access token)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {authType === "basic" && (
          <div className="grid gap-2">
            <Label htmlFor="email">Atlassian account email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="secret">{authType === "basic" ? "API token" : "Access token"}</Label>
          <Input
            id="secret"
            type="password"
            autoComplete="off"
            placeholder={connected ? "Leave blank to keep the stored token" : ""}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          {authType === "basic" && (
            <p className="text-xs text-muted-foreground">
              Create a token at id.atlassian.com/manage/api-tokens. It is stored in your OS credential vault and
              never exposed to the UI.
            </p>
          )}
        </div>
        <div>
          <Button type="submit" disabled={!canSubmit || connect.isPending}>
            {connect.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
            Test &amp; save connection
          </Button>
        </div>
      </form>
    </div>
  );
}
