import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  check: vi.fn(), download: vi.fn(), install: vi.fn(), flush: vi.fn(), version: vi.fn(),
  error: vi.fn(), toast: vi.fn(), dismiss: vi.fn(),
}));
vi.mock("@/api/client", () => ({ updaterApi: { check: h.check, download: h.download, install: h.install } }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: h.version }));
vi.mock("@/lib/notify", () => ({ notify: { error: h.error, info: vi.fn() } }));
vi.mock("sonner", () => ({ toast: Object.assign(h.toast, { dismiss: h.dismiss }) }));
vi.mock("./persist", async () => {
  const { createJSONStorage } = await import("zustand/middleware");
  return { fileStorage: () => createJSONStorage(() => localStorage), flushStores: h.flush };
});

import { useUpdater } from "./updater";

const initial = useUpdater.getState();
const release = { version: "1.2.0", notes: "## Changes\n\n- A useful fix" };

beforeEach(() => {
  vi.resetAllMocks();
  useUpdater.setState(initial, true);
  localStorage.clear();
  h.version.mockResolvedValue("1.2.0");
  h.check.mockResolvedValue(release);
  h.download.mockResolvedValue(undefined);
  h.flush.mockResolvedValue(undefined);
  h.install.mockResolvedValue(undefined);
});

it("shows notes during downloading, preserves downloads on dismissal, and reopens from the ready toast", async () => {
  let finish!: () => void;
  h.download.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const downloading = useUpdater.getState().checkAndDownload();
  await vi.waitFor(() => expect(useUpdater.getState().status).toBe("downloading"));
  expect(useUpdater.getState()).toMatchObject({ available: release, notesDialog: "available" });
  await useUpdater.getState().install();
  expect(h.install).not.toHaveBeenCalled();
  await useUpdater.getState().dismissNotes();
  expect(useUpdater.getState().notesDialog).toBeNull();
  finish();
  await downloading;
  expect(useUpdater.getState().status).toBe("ready");
  const toastOptions = h.toast.mock.calls[0][1] as { action: { onClick: () => void } };
  toastOptions.action.onClick();
  expect(useUpdater.getState().notesDialog).toBe("available");
});

it("flushes the release record before invoking installation and blocks duplicate install attempts", async () => {
  let saved!: () => void;
  h.flush.mockImplementation(() => new Promise<void>((resolve) => { saved = resolve; }));
  useUpdater.setState({ available: release, status: "ready" });
  const installing = useUpdater.getState().install();
  expect(useUpdater.getState().pendingInstall).toEqual(release);
  expect(JSON.parse(localStorage.getItem("updater")!).state.pendingInstall).toEqual(release);
  expect(h.install).not.toHaveBeenCalled();
  await useUpdater.getState().install();
  useUpdater.getState().setChannel("nightly");
  expect(useUpdater.getState().channel).toBe("stable");
  saved();
  await installing;
  expect(h.install).toHaveBeenCalledOnce();
});

it.each(["save", "install"])("surfaces %s failures and clears the unsuccessful installation record", async (failure) => {
  const error = new Error("Installation could not complete");
  if (failure === "save") h.flush.mockRejectedValueOnce(error);
  else h.install.mockRejectedValueOnce(error);
  useUpdater.setState({ available: release, status: "ready" });
  await useUpdater.getState().install();
  expect(useUpdater.getState()).toMatchObject({ status: "error", pendingInstall: null, error: error.message });
  expect(h.error).toHaveBeenCalledWith(error, "Could not install the update");
  if (failure === "save") expect(h.install).not.toHaveBeenCalled();
  useUpdater.setState({ initialized: false });
  await useUpdater.getState().initialize();
  expect(useUpdater.getState().notesDialog).toBeNull();
});

it("shows hydrated notes offline once for the exact installed version, then persists dismissal", async () => {
  localStorage.setItem("updater", JSON.stringify({ version: 1, state: { channel: "nightly", autoCheck: false, pendingInstall: release } }));
  await useUpdater.persist.rehydrate();
  await Promise.all([useUpdater.getState().initialize(), useUpdater.getState().initialize()]);
  expect(h.version).toHaveBeenCalledOnce();
  expect(h.check).not.toHaveBeenCalled();
  expect(useUpdater.getState()).toMatchObject({ notesDialog: "installed", pendingInstall: release, autoCheck: false });
  await useUpdater.getState().dismissNotes();
  expect(h.flush).toHaveBeenCalledOnce();
  expect(JSON.parse(localStorage.getItem("updater")!).state.pendingInstall).toBeNull();
  useUpdater.setState({ initialized: false });
  await useUpdater.getState().initialize();
  expect(useUpdater.getState().notesDialog).toBeNull();
});

it.each([null, { ...release, version: "1.1.0" }, { ...release, version: "1.2.0-nightly.42" }])(
  "does not claim an update succeeded for an absent or mismatched record %j", async (pendingInstall) => {
    useUpdater.setState({ pendingInstall });
    await useUpdater.getState().initialize();
    expect(useUpdater.getState().notesDialog).toBeNull();
    expect(useUpdater.getState().pendingInstall).toEqual(pendingInstall);
  },
);

it("does not hide What's New when a newer background update is found", async () => {
  useUpdater.setState({ pendingInstall: release });
  await useUpdater.getState().initialize();
  h.check.mockResolvedValue({ ...release, version: "1.3.0" });
  await useUpdater.getState().checkAndDownload();
  expect(useUpdater.getState().notesDialog).toBe("installed");
  await useUpdater.getState().dismissNotes();
  expect(useUpdater.getState().notesDialog).toBe("available");
});

it("keeps the installed notes recoverable and reports dismissal save failures", async () => {
  useUpdater.setState({ pendingInstall: release, notesDialog: "installed" });
  h.flush.mockRejectedValueOnce(new Error("Disk full"));
  await useUpdater.getState().dismissNotes();
  expect(useUpdater.getState()).toMatchObject({ notesDialog: "installed", pendingInstall: release });
  expect(h.error).toHaveBeenCalledWith(expect.any(Error), "Could not save release notes dismissal");
});

it("ignores duplicate dismissal while its durable save is pending", async () => {
  let saved!: () => void;
  h.flush.mockImplementation(() => new Promise<void>((resolve) => { saved = resolve; }));
  useUpdater.setState({ pendingInstall: release, notesDialog: "installed" });
  const dismissing = useUpdater.getState().dismissNotes();
  await useUpdater.getState().dismissNotes();
  expect(h.flush).toHaveBeenCalledOnce();
  saved();
  await dismissing;
  expect(useUpdater.getState()).toMatchObject({ notesDialog: null, pendingInstall: null, dismissingNotes: false });
});

it("hydrates legacy preferences without a pending update and reports version lookup failures", async () => {
  localStorage.setItem("updater", JSON.stringify({ version: 1, state: { channel: "nightly", autoCheck: false } }));
  await useUpdater.persist.rehydrate();
  expect(useUpdater.getState()).toMatchObject({ channel: "nightly", autoCheck: false, pendingInstall: null });
  h.version.mockRejectedValueOnce(new Error("Version unavailable"));
  await useUpdater.getState().initialize();
  expect(h.error).toHaveBeenCalledWith(expect.any(Error), "Could not read the installed version");
});

it("does not show notes from a check for a channel that is no longer selected", async () => {
  let found!: (value: typeof release) => void;
  h.check.mockImplementation(() => new Promise<typeof release>((resolve) => { found = resolve; }));
  const checking = useUpdater.getState().checkAndDownload();
  useUpdater.getState().setChannel("nightly");
  found(release);
  await checking;
  expect(h.download).not.toHaveBeenCalled();
  expect(useUpdater.getState()).toMatchObject({ available: null, notesDialog: null });
});
