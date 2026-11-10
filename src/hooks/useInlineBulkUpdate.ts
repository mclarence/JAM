import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import type { AssetObject, ConnectionInfo, ObjectAttributeValue, ObjectTypeAttribute } from "@/api/types";
import { runCachedBatch } from "@/api/batchMutation";
import { captureMutationContext } from "@/api/mutationCache";
import type { BatchContext, BatchFailure, BatchJob } from "@/lib/batchUpdate";
import { displayValue, editorKind } from "@/lib/attributes";
import { notify } from "@/lib/notify";
import { useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";

export interface InlineBulkInput {
  objects: AssetObject[];
  attr: ObjectTypeAttribute;
  value: string;
  optimistic: ObjectAttributeValue[];
}

interface Save {
  label: string;
  contextKey: string;
  context: BatchContext;
  failures: BatchFailure[];
  done: number;
  total: number;
  updated: number;
  unchanged: number;
  running: boolean;
  error?: string;
}

export function useInlineBulkUpdate(contextKey: string, attributes: ObjectTypeAttribute[]) {
  const qc = useQueryClient();
  const currentKey = useRef(contextKey);
  currentKey.current = contextKey;
  const busy = useRef(false);
  const [save, setSave] = useState<Save | null>(null);

  const execute = async (initial: Save, jobs: BatchJob[]) => {
    if (busy.current) {
      notify.error("A bulk update is already running.");
      return;
    }
    busy.current = true;
    const running = { ...initial, running: true, done: 0, total: jobs.length, failures: [] };
    setSave(running);
    try {
      const result = await runCachedBatch(qc, jobs, (done) => setSave((s) => s && { ...s, done }), initial.context);
      setSave({
        ...running, running: false, done: jobs.length,
        failures: result.failures,
        updated: initial.updated + result.updated,
        unchanged: initial.unchanged + result.unchanged,
      });
      if (result.failures.length) notify.error(`${result.failures.length} of ${jobs.length} updates failed`);
      else notify.success(`Updated ${initial.updated + result.updated} assets`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSave({ ...running, running: false, error: message });
      notify.error(error, "Could not finish the bulk update. Refresh assets before trying again");
    } finally {
      busy.current = false;
    }
  };

  const start = (input: InlineBulkInput) => {
    const { objects, attr, value, optimistic } = input;
    if (!objects.length || editorKind(attr) === "readonly" ||
      objects.some((object) => useUi.getState().staleAssets[object.id])) {
      notify.error("The selected assets cannot be edited. Refresh stale assets and select an editable attribute.");
      return;
    }
    if (value === "" && (attr.minimumCardinality ?? 0) > 0) {
      notify.error(`"${attr.name}" is required and cannot be cleared.`);
      return;
    }
    const captured = captureMutationContext(qc);
    const key = currentKey.current;
    const action = {
      id: crypto.randomUUID(), attrId: attr.id, mode: value === "" ? "clear" as const : "set" as const,
      value, display: optimistic.map(displayValue).join(", "),
    };
    const context: BatchContext = {
      attributes, actions: [action], rules: useSettings.getState().rules,
      connection: qc.getQueryData<ConnectionInfo | null>(qk.connection) ?? undefined,
      isCurrent: captured,
    };
    void execute({
      label: attr.name, contextKey: key, context, failures: [], done: 0, total: objects.length,
      updated: 0, unchanged: 0, running: false,
    }, objects.map((object) => ({ object, payload: [] })));
  };

  const retry = () => {
    if (!save || !save.failures.length) return;
    if (save.contextKey !== currentKey.current || !save.context.isCurrent?.()) {
      notify.error("The table context changed. Select the assets again before updating.");
      return;
    }
    void execute(save, save.failures.map((failure) => failure.job));
  };
  return {
    save, start, retry,
    busy: !!save?.running,
    canRetry: !!save?.failures.length && save.contextKey === contextKey && !!save.context.isCurrent?.(),
    dismiss: () => { if (!busy.current) setSave(null); },
  };
}
