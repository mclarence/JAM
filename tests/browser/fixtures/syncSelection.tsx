import { createRoot } from "react-dom/client";
import { SyncTab } from "../../../src/components/settings/SyncTab";
import { syncActions, useSync } from "../../../src/store/sync";
import type { SyncCategory } from "../../../src/lib/sync/categories";
import "../../../src/index.css";

const fixture = {
  selections: [] as SyncCategory[][],
  confirmations: [] as Record<string, string>[],
  review: () => useSync.setState({
    phase: "selectionReview",
    selectionReview: {
      categories: ["columns"], fingerprint: "columns-1",
      rows: [{ rid: "shared|columns:c:w:42", local: { hidden: ["ios-only"] },
        options: [{ versionId: "v1", value: { hidden: ["desktop-only"] } }] }],
    },
  }),
  refreshReview: () => useSync.setState({
    selectionReview: {
      categories: ["columns"], fingerprint: "columns-2",
      rows: [{ rid: "shared|columns:c:w:42", local: { hidden: ["ios-only"] },
        options: [{ versionId: "v2", value: { hidden: ["new-desktop"] } }] }],
    },
  }),
};

declare global {
  interface Window { syncSelectionFixture: typeof fixture }
}
window.syncSelectionFixture = fixture;
syncActions.saveSelection = async (selected) => {
  fixture.selections.push(selected);
  useSync.setState({ selected, phase: selected.length ? "ready" : "paused" });
};
syncActions.confirmSelectionReview = async (choices) => {
  fixture.confirmations.push(choices);
  useSync.setState({ phase: "ready", selectionReview: null });
};
syncActions.cancelSelectionReview = async () => useSync.setState({ phase: "paused", selectionReview: null, selected: [] });
useSync.setState({
  phase: "selectionRequired",
  status: { configured: true, signedIn: true, email: "fixture@example.invalid", generationId: "g", deviceId: "d" },
});
createRoot(document.getElementById("root")!).render(<div className="p-6"><SyncTab /></div>);
