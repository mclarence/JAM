import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AuthType, ConnectionInfo } from "./types";

export type ApiErrorKind = "notConnected" | "unauthorized" | "http" | "network" | "keyring" | "invalid" | "io" | "unknown";

export class ApiError extends Error {
  constructor(
    message: string,
    public kind: ApiErrorKind = "unknown",
    public status?: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e && typeof e === "object" && "message" in e) {
    const { message, kind, status } = e as { message: string; kind?: ApiErrorKind; status?: number | null };
    return new ApiError(message, kind ?? "unknown", status);
  }
  return new ApiError(typeof e === "string" ? e : "Unexpected error");
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new ApiError("This feature requires the desktop app (run with `pnpm tauri dev`).", "notConnected");
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toApiError(e);
  }
}

type QueryValue = string | number | boolean | undefined | null;

export function assetsRequest<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, QueryValue>; body?: unknown } = {},
): Promise<T> {
  const query = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, String(v)])
    : undefined;
  return call<T>("assets_request", { method, path, query, body: opts.body ?? null });
}

export interface ConnectInput {
  siteUrl: string;
  authType: AuthType;
  email: string;
  secret?: string;
}

export const connectionApi = {
  connect: (input: ConnectInput) => call<ConnectionInfo>("connect", { input }),
  get: () => (isTauri() ? call<ConnectionInfo | null>("get_connection") : Promise.resolve(null)),
  disconnect: () => call<void>("disconnect"),
};

export const fileApi = {
  savePdf: (path: string, dataB64: string) => call<void>("save_pdf", { path, dataB64 }),
  openPdf: (fileName: string, dataB64: string) => call<void>("open_pdf", { fileName, dataB64 }),
};
