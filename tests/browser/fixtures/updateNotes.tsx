import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { UpdateNotesDialog } from "../../../src/components/updates/UpdateNotesDialog";
import { useUpdater } from "../../../src/store/updater";
import "../../../src/index.css";

const release = {
  version: "1.2.0",
  notes: `## Improvements

- Faster asset scanning
- Better filters

[Full release](https://example.invalid/release)

[Unsafe link](javascript:alert(1))

<script>window.injected = true</script>

![Remote tracking image](https://example.invalid/tracker.png)`,
};
const fixture = {
  available: (notes = release.notes) => useUpdater.setState({
    available: { ...release, notes }, status: "downloading",
    progress: { downloaded: 50, total: 100 }, notesDialog: "available",
  }),
  ready: () => useUpdater.setState({ status: "ready", progress: null }),
  installed: () => useUpdater.setState({ pendingInstall: release, notesDialog: "installed" }),
};
declare global {
  interface Window { updateNotesFixture: typeof fixture }
}
window.updateNotesFixture = fixture;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <button onClick={() => useUpdater.getState().showNotes()}>View release notes</button>
    <UpdateNotesDialog />
  </StrictMode>,
);
