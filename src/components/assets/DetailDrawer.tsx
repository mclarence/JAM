import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, History, Loader2 } from "lucide-react";
import {
  useAttributes,
  useHistory,
  useInboundReferences,
  useObject,
  useReferenceInfo,
  useStatusTypes,
  useUpdateAttribute,
} from "@/api/queries";
import { AttrType, type AssetObject } from "@/api/types";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/primitives";
import { editorKind, getAttrValues, sortAttributes } from "@/lib/attributes";
import { cn } from "@/lib/utils";
import { useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";
import { AttributeValue } from "./AttributeValue";
import { CellEditor } from "./CellEditor";

export function DetailDrawer({ fallback }: { fallback?: (id: string) => AssetObject | undefined }) {
  const { detailObjectId, openDetail } = useUi();
  const query = useObject(detailObjectId);
  const object = query.data ?? (detailObjectId ? fallback?.(detailObjectId) : undefined);

  return (
    <Sheet open={!!detailObjectId} onOpenChange={(o) => !o && openDetail(null)}>
      <SheetContent className="w-[640px] max-w-[90vw] gap-0 p-0 sm:max-w-[640px]">
        {object ? (
          <DetailBody object={object} />
        ) : (
          <div className="grid gap-3 p-6">
            <SheetTitle className="sr-only">Loading</SheetTitle>
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-64" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailBody({ object }: { object: AssetObject }) {
  const schemaId = useSettings((s) => s.schemaId);
  const attrs = useAttributes(object.objectType.id);
  const statuses = useStatusTypes(schemaId);
  const update = useUpdateAttribute();
  const [editingAttr, setEditingAttr] = useState<string | null>(null);

  return (
    <>
      <div className="border-b p-6 pr-12">
        <SheetTitle className="truncate">{object.label}</SheetTitle>
        <SheetDescription>
          {object.objectKey} · {object.objectType.name} · updated {new Date(object.updated).toLocaleString()}
        </SheetDescription>
      </div>
      <Tabs defaultValue="attributes" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-6 mt-4 self-start">
          <TabsTrigger value="attributes">Attributes</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="links">Linked objects</TabsTrigger>
        </TabsList>

        <TabsContent value="attributes" className="min-h-0 flex-1 overflow-auto px-6 pb-6">
          {attrs.isLoading && <Skeleton className="h-64" />}
          <dl className="divide-y">
            {sortAttributes(attrs.data ?? [])
              .filter((a) => !a.hidden)
              .map((attr) => {
                const values = getAttrValues(object, attr.id);
                const editable = editorKind(attr) !== "readonly";
                const isEditing = editingAttr === attr.id;
                return (
                  <div key={attr.id} className="grid grid-cols-[180px_1fr] items-center gap-4 py-2 text-sm">
                    <dt className="truncate text-muted-foreground" title={attr.description || attr.name}>
                      {attr.name}
                    </dt>
                    <dd
                      className={cn(
                        "relative flex min-h-8 min-w-0 items-center rounded px-2",
                        editable && !isEditing && "cursor-cell hover:bg-accent/50",
                        isEditing && "p-0",
                      )}
                      onDoubleClick={() => editable && setEditingAttr(attr.id)}
                      title={editable ? "Double-click to edit" : undefined}
                    >
                      {isEditing ? (
                        <div className="relative h-8 w-full">
                          <CellEditor
                            attr={attr}
                            values={values}
                            statuses={statuses.data ?? []}
                            onCancel={() => setEditingAttr(null)}
                            onCommit={(value, optimistic) => {
                              setEditingAttr(null);
                              update.mutate({ object, attr, value, optimistic });
                            }}
                          />
                        </div>
                      ) : (
                        <span className="min-w-0 select-text">
                          <AttributeValue attr={attr} values={values} />
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
          </dl>
        </TabsContent>

        <TabsContent value="history" className="min-h-0 flex-1 overflow-auto px-6 pb-6">
          <HistoryList id={object.id} />
        </TabsContent>

        <TabsContent value="links" className="min-h-0 flex-1 overflow-auto px-6 pb-6">
          <LinkedObjects object={object} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function HistoryList({ id }: { id: string }) {
  const history = useHistory(id);
  if (history.isLoading) return <Skeleton className="h-40" />;
  if (!history.data?.length) return <p className="text-sm text-muted-foreground">No history recorded.</p>;
  return (
    <ol className="relative ml-2 border-l">
      {history.data.map((h) => (
        <li key={h.id} className="mb-4 ml-4">
          <span className="absolute -left-1.5 mt-1.5 size-3 rounded-full border bg-background" />
          <p className="text-sm">
            <span className="font-medium">{h.actor?.displayName ?? "Unknown"}</span>{" "}
            {h.affectedAttribute ? (
              <>
                changed <span className="font-medium">{h.affectedAttribute}</span>
              </>
            ) : (
              "created the object"
            )}
          </p>
          {h.affectedAttribute && (
            <p className="text-xs text-muted-foreground select-text">
              <span className="line-through">{h.oldValue || "∅"}</span> → <span>{h.newValue || "∅"}</span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            <History className="mr-1 inline size-3" />
            {new Date(h.created).toLocaleString()}
          </p>
        </li>
      ))}
    </ol>
  );
}

function LinkedObjects({ object }: { object: AssetObject }) {
  const attrs = useAttributes(object.objectType.id);
  const info = useReferenceInfo(object.id);
  const inbound = useInboundReferences(object.objectKey);
  const openDetail = useUi((s) => s.openDetail);

  const outbound = (attrs.data ?? [])
    .filter((a) => a.type === AttrType.ObjectReference)
    .flatMap((a) =>
      getAttrValues(object, a.id)
        .filter((v) => v.referencedObject)
        .map((v) => ({ attr: a.name, ref: v.referencedObject! })),
    );

  return (
    <div className="grid gap-6">
      <section>
        <h4 className="mb-2 flex items-center gap-2 text-sm font-medium">
          <ArrowUpRight className="size-4" /> Outbound references
        </h4>
        {outbound.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {outbound.map(({ attr, ref }, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="w-36 truncate text-muted-foreground">{attr}</span>
                <button type="button" className="truncate hover:underline" onClick={() => openDetail(ref.id)}>
                  {ref.label}
                </button>
                <span className="ml-auto text-xs text-muted-foreground">{ref.objectKey}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="mb-2 flex items-center gap-2 text-sm font-medium">
          <ArrowDownLeft className="size-4" /> Inbound references
          {inbound.isFetching && <Loader2 className="size-3 animate-spin" />}
        </h4>
        {info.data && info.data.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {info.data.map((r) => (
              <span key={r.objectType.id} className="rounded border px-2 py-0.5">
                {r.objectType.name}: {r.numberOfReferencedObjects}
              </span>
            ))}
          </div>
        )}
        {inbound.data?.length ? (
          <ul className="divide-y rounded-md border">
            {inbound.data.map((o) => (
              <li key={o.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="w-36 truncate text-muted-foreground">{o.objectType.name}</span>
                <button type="button" className="truncate hover:underline" onClick={() => openDetail(o.id)}>
                  {o.label}
                </button>
                <span className="ml-auto text-xs text-muted-foreground">{o.objectKey}</span>
              </li>
            ))}
          </ul>
        ) : (
          !inbound.isFetching && <p className="text-sm text-muted-foreground">None.</p>
        )}
      </section>
    </div>
  );
}
