import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import { useCreateObject } from "@/api/queries";
import type { ObjectIn, ObjectTypeAttribute, StatusType } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Checkbox, Label } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { editorKind, selectOptions, type EditorKind } from "@/lib/attributes";
import { findNextAssetTag, parseTemplate, tagNumber } from "@/lib/assetTag";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useSettings } from "@/store/settings";
import { ReferencePicker } from "./ReferencePicker";
import { StatusBadge } from "./StatusBadge";

const NONE = "__none";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objectTypeId: string;
  objectTypeName: string;
  attributes: ObjectTypeAttribute[];
  statuses: StatusType[];
}

export function CreateAssetDialog({ open, onOpenChange, ...rest }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-2xl flex-col gap-0 overflow-hidden p-0" aria-describedby={undefined}>
        {/* Mounted only while open so the form resets each time the dialog is opened. */}
        <CreateForm {...rest} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function isRequired(attr: ObjectTypeAttribute) {
  return (attr.minimumCardinality ?? 0) > 0;
}

/** Convert the form's raw input value into the value sent to the API. */
function toApiValue(kind: EditorKind, raw: string) {
  if (kind === "datetime") return raw ? new Date(raw).toISOString() : "";
  return raw.trim();
}

function CreateForm({
  objectTypeId,
  objectTypeName,
  attributes,
  statuses,
  onClose,
}: Omit<Props, "open" | "onOpenChange"> & { onClose: () => void }) {
  const create = useCreateObject();
  const [values, setValues] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [createAnother, setCreateAnother] = useState(false);

  const fields = useMemo(
    () => attributes.map((attr) => ({ attr, kind: editorKind(attr) })).filter((f) => f.kind !== "readonly"),
    [attributes],
  );

  const set = (id: string, value: string, label?: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setLabels((l) => ({ ...l, [id]: label ?? value }));
  };

  const schemaId = useSettings((s) => s.schemaId);
  const tagConfig = useSettings((s) => s.assetTags[objectTypeId]);
  const tagAttr = tagConfig ? fields.find((f) => f.attr.id === tagConfig.attributeId)?.attr : undefined;
  const tagTouched = useRef(false);
  const [tagLoading, setTagLoading] = useState(false);

  const suggestTag = async (minNumber?: number, overwrite = false) => {
    if (!tagAttr || !tagConfig || !schemaId) return;
    setTagLoading(true);
    try {
      const tag = await findNextAssetTag({ schemaId, attr: tagAttr, template: tagConfig.template, minNumber });
      if (tag && (overwrite || !tagTouched.current)) set(tagAttr.id, tag);
    } catch (e) {
      notify.error(e, "Could not determine the next asset tag");
    } finally {
      setTagLoading(false);
    }
  };

  useEffect(() => {
    void suggestTag();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagAttr?.id, tagConfig?.template, schemaId]);

  const missing = fields.filter(({ attr }) => isRequired(attr) && !(values[attr.id] ?? "").trim());

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (missing.length) {
      setShowErrors(true);
      return;
    }
    const body: ObjectIn = {
      objectTypeId,
      attributes: fields.flatMap(({ attr, kind }) => {
        const value = toApiValue(kind, values[attr.id] ?? "");
        return value ? [{ objectTypeAttributeId: attr.id, objectAttributeValues: [{ value }] }] : [];
      }),
    };
    create.mutate(body, {
      onSuccess: (obj) => {
        notify.success(`Created ${obj?.objectKey ?? objectTypeName}`);
        if (createAnother) {
          setShowErrors(false);
          if (tagAttr && tagConfig) {
            const parsed = parseTemplate(tagConfig.template);
            const used = parsed ? tagNumber(parsed, values[tagAttr.id] ?? "") : null;
            tagTouched.current = false;
            // The search index may lag behind the create, so skip past the tag just used.
            void suggestTag(used === null ? undefined : used + 1, true);
          }
        } else onClose();
      },
      onError: (err) => notify.error(err, `Could not create ${objectTypeName}`),
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-6 pr-12">
        <DialogTitle>Add {objectTypeName}</DialogTitle>
        <DialogDescription className="mt-1.5">
          Fields marked <span className="text-destructive">*</span> are required.
        </DialogDescription>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 overflow-auto p-6 sm:grid-cols-2">
        {fields.map(({ attr, kind }) => {
          const id = `create-${attr.id}`;
          const invalid = showErrors && missing.some((f) => f.attr.id === attr.id);
          return (
            <div key={attr.id} className={cn("grid content-start gap-1.5", kind === "textarea" && "sm:col-span-2")}>
              <Label htmlFor={id} title={attr.description}>
                {attr.name}
                {isRequired(attr) && <span className="ml-0.5 text-destructive">*</span>}
              </Label>
              <FieldInput
                id={id}
                attr={attr}
                kind={kind}
                value={values[attr.id] ?? ""}
                label={labels[attr.id] ?? ""}
                statuses={statuses}
                invalid={invalid}
                onChange={(v, l) => {
                  if (attr.id === tagAttr?.id) tagTouched.current = true;
                  set(attr.id, v, l);
                }}
              />
              {attr.id === tagAttr?.id && (
                <p className="text-xs text-muted-foreground">
                  {tagLoading ? "Finding next available tag…" : "Next available tag; edit to override."}
                </p>
              )}
              {invalid && <p className="text-xs text-destructive">Required</p>}
            </div>
          );
        })}
        {fields.length === 0 && (
          <p className="text-sm text-muted-foreground sm:col-span-2">This object type has no editable attributes.</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 border-t p-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id="create-another"
            checked={createAnother}
            onCheckedChange={(c) => setCreateAnother(c === true)}
          />
          <Label htmlFor="create-another" className="cursor-pointer font-normal">
            Create another
          </Label>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || tagLoading}>
            {create.isPending && <Loader2 className="animate-spin" />} Create
          </Button>
        </div>
      </div>
    </form>
  );
}

function FieldInput({
  id,
  attr,
  kind,
  value,
  label,
  statuses,
  invalid,
  onChange,
}: {
  id: string;
  attr: ObjectTypeAttribute;
  kind: EditorKind;
  value: string;
  label: string;
  statuses: StatusType[];
  invalid: boolean;
  onChange: (value: string, label?: string) => void;
}) {
  const required = isRequired(attr);
  const triggerClass = cn(invalid && "border-destructive");

  const choice = (options: { value: string; label: React.ReactNode }[]) => (
    <Select value={value || undefined} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger id={id} className={triggerClass}>
        <SelectValue placeholder="Select…" />
      </SelectTrigger>
      <SelectContent>
        {!required && <SelectItem value={NONE}>(none)</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  switch (kind) {
    case "status": {
      const allowed = attr.typeValueMulti?.length
        ? statuses.filter((s) => attr.typeValueMulti!.includes(s.id))
        : statuses;
      return choice(allowed.map((s) => ({ value: s.id, label: <StatusBadge name={s.name} category={s.category} /> })));
    }
    case "select":
      return choice(selectOptions(attr).map((o) => ({ value: o, label: o })));
    case "boolean":
      return choice([
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ]);
    case "reference":
      return <ReferenceField id={id} attr={attr} value={value} label={label} invalid={invalid} onChange={onChange} />;
    case "textarea":
      return (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={triggerClass}
        />
      );
    case "integer":
      return <Input id={id} type="number" step="1" value={value} onChange={(e) => onChange(e.target.value)} className={triggerClass} />;
    case "double":
      return <Input id={id} type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} className={triggerClass} />;
    case "date":
      return <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} className={triggerClass} />;
    case "datetime":
      return (
        <Input
          id={id}
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={triggerClass}
        />
      );
    default:
      return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className={triggerClass} />;
  }
}

/** Autocomplete combobox backed by server-side search of the referenced object type. */
function ReferenceField({
  id,
  attr,
  value,
  label,
  invalid,
  onChange,
}: {
  id: string;
  attr: ObjectTypeAttribute;
  value: string;
  label: string;
  invalid: boolean;
  onChange: (value: string, label?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="relative">
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            className={cn(
              "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring",
              invalid && "border-destructive",
            )}
          >
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value ? label : `Search ${attr.referenceObjectType?.name ?? attr.name}…`}
            </span>
            {!value && <ChevronDown className="size-4 opacity-50" />}
          </button>
        </PopoverTrigger>
        {value && (
          <button
            type="button"
            aria-label={`Clear ${attr.name}`}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onChange("")}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <PopoverContent className="w-auto p-0">
        <ReferencePicker
          attr={attr}
          onPick={(r) => {
            onChange(r.objectKey, r.label);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
