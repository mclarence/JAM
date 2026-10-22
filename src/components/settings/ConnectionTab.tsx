import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, Globe, Loader2, LogOut, PlugZap, TriangleAlert } from "lucide-react";
import { connectionApi, networkApi } from "@/api/client";
import { qk, useConnection } from "@/api/queries";
import type { AuthType } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, Checkbox, Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";

export function ConnectionTab() {
  const qc = useQueryClient();
  const connection = useConnection();
  const [siteUrl, setSiteUrl] = useState("");
  const [authType, setAuthType] = useState<AuthType>("basic");
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [acceptInvalidCerts, setAcceptInvalidCerts] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);

  const network = useQuery({ queryKey: ["network"], queryFn: networkApi.get, staleTime: Infinity });
  useEffect(() => {
    if (!network.data) return;
    setAcceptInvalidCerts(network.data.acceptInvalidCerts);
    setProxyUrl(network.data.proxyUrl ?? "");
    if (network.data.acceptInvalidCerts || network.data.proxyUrl) setShowAdvanced(true);
  }, [network.data]);

  useEffect(() => {
    if (connection.data) {
      setSiteUrl(connection.data.siteUrl);
      setAuthType(connection.data.authType);
      setEmail(connection.data.email);
    }
  }, [connection.data]);

  const connect = useMutation({
    mutationFn: async () => {
      await networkApi.set({ acceptInvalidCerts, proxyUrl: proxyUrl.trim() || null });
      return connectionApi.connect({ siteUrl, authType, email, secret: secret || undefined });
    },
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

  const signInStart = useMutation({
    mutationFn: () => networkApi.signInStart(siteUrl),
    onSuccess: () => setSignInOpen(true),
    onError: (e) => notify.error(e, "Could not open the sign-in window"),
  });
  const signInFinish = useMutation({
    mutationFn: () => networkApi.signInFinish(siteUrl),
    onSuccess: (count) => {
      setSignInOpen(false);
      if (count === 0) notify.info("No session cookies were found. Make sure you finished signing in, then try again.");
      else notify.success(`Captured ${count} proxy session cookies`);
      if (canSubmit) connect.mutate();
    },
    onError: (e) => notify.error(e, "Could not finish proxy sign-in"),
  });
  const signInCancel = useMutation({
    mutationFn: networkApi.signInCancel,
    onSettled: () => setSignInOpen(false),
  });

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

        <Card className="grid gap-3 p-4">
          <div className="flex items-start gap-3">
            <Globe className="mt-0.5 size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">Web proxy sign-in</p>
              <p className="text-muted-foreground">
                On networks where a web filter (for example Zscaler) asks you to log in first, sign in here. A browser
                window opens on your Atlassian site; complete the login, then click Finish. The session is kept for this
                run of the app only.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {!signInOpen ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!siteUrl.trim() || signInStart.isPending}
                onClick={() => signInStart.mutate()}
              >
                {signInStart.isPending ? <Loader2 className="animate-spin" /> : <Globe />} Sign in to web proxy
              </Button>
            ) : (
              <>
                <Button type="button" size="sm" disabled={signInFinish.isPending} onClick={() => signInFinish.mutate()}>
                  {signInFinish.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Finish (I have signed in)
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => signInCancel.mutate()}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        </Card>

        <div className="grid gap-3">
          <button
            type="button"
            className="flex w-fit items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
          >
            {showAdvanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Advanced
          </button>
          {showAdvanced && (
            <Card className="grid gap-4 p-4">
              <div className="grid gap-2">
                <Label htmlFor="proxy-url">Proxy URL (optional)</Label>
                <Input
                  id="proxy-url"
                  placeholder="http://proxy.example.com:8080"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Overrides the system proxy. Set this if your network uses a PAC script, which the app cannot read.
                </p>
              </div>
              <Label className="flex cursor-pointer items-start gap-3 font-normal">
                <Checkbox
                  className="mt-0.5"
                  checked={acceptInvalidCerts}
                  onCheckedChange={(v) => setAcceptInvalidCerts(!!v)}
                />
                <span>
                  Ignore certificate errors
                  <span className="block text-xs text-muted-foreground">
                    Skips TLS certificate validation for all requests, including your API token. The app already
                    trusts certificates in your OS store, so try installing your web filter's root CA there first.
                  </span>
                </span>
              </Label>
              {acceptInvalidCerts && (
                <p className="flex items-center gap-2 text-xs text-destructive">
                  <TriangleAlert className="size-4 shrink-0" /> Anyone able to intercept your traffic could read the API
                  token. Use only on a network you trust.
                </p>
              )}
            </Card>
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
