import { useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useAttributes, useConnection, useObjectTypes, useSchemas, useStatusTypes } from "@/api/queries";
import type { ObjectTypeAttribute, StatusType } from "@/api/types";
import { AttributeValueInput } from "@/components/assets/AttributeValueInput";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Card, Checkbox, Label, Switch } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sortAttributes } from "@/lib/attributes";
import {
  ruleActionAttributes, ruleValueKind, validateRule,
  type Rule, type RuleAction, type RuleCondition, type RuleOperation, type RuleOperator, type RuleValue,
} from "@/lib/rules";
import { useSettings } from "@/store/settings";

const operations: { value: RuleOperation; label: string }[] = [
  { value: "edit", label: "Individual edits" },
  { value: "batch", label: "Batch updates" },
  { value: "scan", label: "Quick Scan" },
  { value: "create", label: "Object creation" },
];
const operators: { value: RuleOperator; label: string }[] = [
  { value: "isSet", label: "Is set" },
  { value: "isEmpty", label: "Is empty" },
  { value: "equals", label: "Equals" },
  { value: "notEquals", label: "Does not equal" },
];
const emptyValue = (): RuleValue => ({ raw: "", display: "" });

export function RulesTab() {
  const connection = useConnection();
  const settings = useSettings();
  const [schemaId, setSchemaId] = useState(settings.schemaId ?? "");
  const [typeId, setTypeId] = useState(settings.objectTypeId ?? "");
  const [editing, setEditing] = useState<Rule | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const schemas = useSchemas();
  const types = useObjectTypes(schemaId || null);
  const attributes = useAttributes(typeId || null);
  const statuses = useStatusTypes(schemaId || null);

  if (!connection.data) return <p className="text-sm text-muted-foreground">Connect to Jira Assets first (Connection tab).</p>;
  const scope = connection.data;
  const attrs = sortAttributes(attributes.data ?? []);
  const statusList = statuses.data ?? [];
  const loading = attributes.isLoading || statuses.isLoading;
  const loadError = attributes.error ?? statuses.error ?? schemas.error ?? types.error;
  const scoped = settings.rules.filter((rule) =>
    rule.cloudId === scope.cloudId && rule.workspaceId === scope.workspaceId && rule.schemaId === schemaId && rule.objectTypeId === typeId,
  );
  const newRule = () => setEditing({
    id: crypto.randomUUID(), name: "", enabled: true, cloudId: scope.cloudId, workspaceId: scope.workspaceId,
    schemaId, objectTypeId: typeId, operations: ["edit", "batch", "scan"], watchedAttributeIds: [], match: "any",
    conditions: [], actions: [],
  });

  return (
    <div className="grid max-w-4xl gap-5">
      <p className="text-sm text-muted-foreground">
        Rules run only for saves made in this app. They are stored on this device for the current Jira workspace.
        A watched field must change; conditions are checked before any rule actions. Later rules win and can override a manual value.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label>Schema</Label>
          <Select value={schemaId || undefined} onValueChange={(value) => { setSchemaId(value); setTypeId(""); setEditing(null); }}>
            <SelectTrigger aria-label="Rule schema"><SelectValue placeholder="Choose a schema" /></SelectTrigger>
            <SelectContent>
              {schemas.data?.map((schema) => <SelectItem key={schema.id} value={schema.id}>{schema.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>Object type</Label>
          <Select value={typeId || undefined} disabled={!schemaId} onValueChange={(value) => { setTypeId(value); setEditing(null); }}>
            <SelectTrigger aria-label="Rule object type"><SelectValue placeholder="Choose an object type" /></SelectTrigger>
            <SelectContent>
              {types.data?.filter((type) => !type.abstractObjectType).map((type) => <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          <span>Could not load rule metadata: {loadError.message}</span>
          <Button size="sm" variant="outline" onClick={() => {
            void schemas.refetch();
            if (schemaId) { void types.refetch(); void statuses.refetch(); }
            if (typeId) void attributes.refetch();
          }}>Retry</Button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-medium">Rules in execution order</h2>
          <p className="text-xs text-muted-foreground">Move rules down to give their actions higher priority.</p>
        </div>
        <Button size="sm" onClick={newRule} disabled={!schemaId || !typeId || loading || !!loadError}>
          <Plus /> New rule
        </Button>
      </div>
      {!typeId ? (
        <p className="text-sm text-muted-foreground">Choose a schema and object type to configure rules.</p>
      ) : scoped.length === 0 ? (
        <p className="text-sm text-muted-foreground">{loading ? "Loading…" : "No rules for this object type."}</p>
      ) : (
        <div className="grid gap-2">
          {scoped.map((rule, index) => {
            const problem = !loading && !loadError ? validateRule(rule, attrs, statusList) : null;
            return (
              <Card key={rule.id} className="flex flex-wrap items-center gap-3 p-3">
                <Switch
                  aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                  checked={rule.enabled}
                  disabled={!rule.enabled && (loading || !!loadError || !!problem)}
                  onCheckedChange={(enabled) => settings.saveRule({ ...rule, enabled })}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{rule.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {rule.operations.map((op) => operations.find((item) => item.value === op)?.label ?? op).join(" · ")}
                  </p>
                  {problem && <p className="mt-1 text-xs text-destructive">Needs attention: {problem}</p>}
                </div>
                <div className="flex gap-1">
                  <Button size="iconSm" variant="ghost" aria-label={`Move ${rule.name} up`} disabled={index === 0} onClick={() => settings.swapRules(rule.id, scoped[index - 1].id)}><ArrowUp /></Button>
                  <Button size="iconSm" variant="ghost" aria-label={`Move ${rule.name} down`} disabled={index === scoped.length - 1} onClick={() => settings.swapRules(rule.id, scoped[index + 1].id)}><ArrowDown /></Button>
                  <Button size="iconSm" variant="ghost" aria-label={`Edit ${rule.name}`} disabled={loading || !!loadError} onClick={() => setEditing(rule)}><Pencil /></Button>
                  <Button size="iconSm" variant="ghost" aria-label={`Delete ${rule.name}`} onClick={() => setDeleting(rule)}><Trash2 /></Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <DialogContent className="max-w-3xl">
            <RuleEditor
              key={editing.id}
              initial={editing}
              attributes={attrs}
              statuses={statusList}
              onCancel={() => setEditing(null)}
              onSave={(rule) => { settings.saveRule(rule); setEditing(null); }}
            />
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        {deleting && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {deleting.name}?</DialogTitle>
              <DialogDescription>This removes the local rule. It does not undo changes already saved to Jira.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => { settings.deleteRule(deleting.id); setDeleting(null); }}>Delete rule</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function RuleEditor({
  initial, attributes, statuses, onCancel, onSave,
}: {
  initial: Rule;
  attributes: ObjectTypeAttribute[];
  statuses: StatusType[];
  onCancel: () => void;
  onSave: (rule: Rule) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const problem = validateRule(draft, attributes, statuses);
  const actionOptions = ruleActionAttributes(attributes);
  const usedActions = new Set(draft.actions.map((action) => action.attributeId));
  const updateCondition = (id: string, patch: Partial<RuleCondition>) =>
    setDraft((rule) => ({ ...rule, conditions: rule.conditions.map((condition) => condition.id === id ? { ...condition, ...patch } : condition) }));
  const updateAction = (id: string, patch: Partial<RuleAction>) =>
    setDraft((rule) => ({ ...rule, actions: rule.actions.map((action) => action.id === id ? { ...action, ...patch } : action) }));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{initial.name ? "Edit rule" : "New rule"}</DialogTitle>
        <DialogDescription>Choose operations, watched fields, conditions, and values to set. Rules do not trigger other rules.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-5">
        <div className="grid gap-2">
          <Label htmlFor="rule-name">Name</Label>
          <Input id="rule-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Activate assigned assets" />
        </div>
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">Run on these operations</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {operations.map((operation) => (
              <label key={operation.value} className="flex items-center gap-2 text-sm">
                <Checkbox checked={draft.operations.includes(operation.value)} onCheckedChange={(checked) => setDraft((rule) => ({
                  ...rule,
                  operations: checked === true ? [...rule.operations, operation.value] : rule.operations.filter((value) => value !== operation.value),
                }))} />
                {operation.label}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Creation is opt-in. A supplied watched value must be nonempty.</p>
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">When any of these attributes changes</legend>
          <div className="grid max-h-40 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
            {attributes.map((attr) => (
              <label key={attr.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={draft.watchedAttributeIds.includes(attr.id)} onCheckedChange={(checked) => setDraft((rule) => ({
                  ...rule,
                  watchedAttributeIds: checked === true ? [...rule.watchedAttributeIds, attr.id] : rule.watchedAttributeIds.filter((id) => id !== attr.id),
                }))} />
                {attr.name}
              </label>
            ))}
            {draft.watchedAttributeIds.filter((id) => !attributes.some((attribute) => attribute.id === id)).map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm text-destructive">
                <Checkbox checked onCheckedChange={() => setDraft((rule) => ({ ...rule, watchedAttributeIds: rule.watchedAttributeIds.filter((item) => item !== id) }))} />
                Missing attribute {id}
              </label>
            ))}
          </div>
        </fieldset>
        <section className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">If</span>
            <Select value={draft.match} onValueChange={(value) => {
              if (value === "any" || value === "all") setDraft({ ...draft, match: value });
            }}>
              <SelectTrigger aria-label="Condition matching" className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="any">Any</SelectItem><SelectItem value="all">All</SelectItem></SelectContent>
            </Select>
            <span className="text-sm">of these conditions match</span>
          </div>
          {draft.conditions.map((condition) => {
            const attr = attributes.find((item) => item.id === condition.attributeId);
            const supportsValue = attr && ruleValueKind(attr) !== "readonly";
            return (
              <div key={condition.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <AttributeSelect value={condition.attributeId} attributes={attributes} label="Condition attribute" onChange={(attributeId) => updateCondition(condition.id, { attributeId, operator: "isSet", value: undefined })} />
                <Select value={condition.operator} onValueChange={(value) => {
                  const op = operators.find((item) => item.value === value)?.value;
                  if (op) updateCondition(condition.id, { operator: op, value: op === "equals" || op === "notEquals" ? (condition.value ?? emptyValue()) : undefined });
                }}>
                  <SelectTrigger aria-label="Condition operator"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {operators.filter((item) => supportsValue || item.value === "isSet" || item.value === "isEmpty").map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {attr && (condition.operator === "equals" || condition.operator === "notEquals") ? (
                  <RuleValueInput attr={attr} value={condition.value ?? emptyValue()} statuses={statuses} onChange={(value) => updateCondition(condition.id, { value })} />
                ) : <span />}
                <Button variant="ghost" size="icon" aria-label="Remove condition" onClick={() => setDraft((rule) => ({ ...rule, conditions: rule.conditions.filter((item) => item.id !== condition.id) }))}><Trash2 /></Button>
              </div>
            );
          })}
          <div><Button size="sm" variant="outline" disabled={!attributes.length} onClick={() => setDraft((rule) => ({
            ...rule, conditions: [...rule.conditions, { id: crypto.randomUUID(), attributeId: attributes[0].id, operator: "isSet" }],
          }))}><Plus /> Add condition</Button></div>
        </section>
        <section className="grid gap-3">
          <h3 className="text-sm font-medium">Then set these attributes</h3>
          {draft.actions.map((action) => {
            const attr = attributes.find((item) => item.id === action.attributeId);
            return (
              <div key={action.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]">
                <AttributeSelect
                  value={action.attributeId}
                  attributes={actionOptions.filter((item) => item.id === action.attributeId || !usedActions.has(item.id))}
                  label="Action attribute"
                  onChange={(attributeId) => updateAction(action.id, { attributeId, value: emptyValue() })}
                />
                {attr ? <RuleValueInput attr={attr} value={action.value} statuses={statuses} onChange={(value) => updateAction(action.id, { value })} /> : <span />}
                <Button variant="ghost" size="icon" aria-label="Remove action" onClick={() => setDraft((rule) => ({ ...rule, actions: rule.actions.filter((item) => item.id !== action.id) }))}><Trash2 /></Button>
              </div>
            );
          })}
          <div><Button size="sm" variant="outline" disabled={!actionOptions.some((attribute) => !usedActions.has(attribute.id))} onClick={() => {
            const attribute = actionOptions.find((item) => !usedActions.has(item.id));
            if (attribute) setDraft((rule) => ({ ...rule, actions: [...rule.actions, { id: crypto.randomUUID(), attributeId: attribute.id, value: emptyValue() }] }));
          }}><Plus /> Add action</Button></div>
        </section>
        {problem && <p role="status" className="text-sm text-destructive">{problem}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button disabled={!!problem} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>Save rule</Button>
      </DialogFooter>
    </>
  );
}

function AttributeSelect({ value, attributes, label, onChange }: {
  value: string;
  attributes: ObjectTypeAttribute[];
  label: string;
  onChange: (value: string) => void;
}) {
  const missing = !attributes.some((attribute) => attribute.id === value);
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger aria-label={label}><SelectValue placeholder="Choose an attribute" /></SelectTrigger>
      <SelectContent>
        {missing && value && <SelectItem value={value}>Missing or unavailable attribute {value}</SelectItem>}
        {attributes.map((attribute) => <SelectItem key={attribute.id} value={attribute.id}>{attribute.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function RuleValueInput({ attr, value, statuses, onChange }: {
  attr: ObjectTypeAttribute;
  value: RuleValue;
  statuses: StatusType[];
  onChange: (value: RuleValue) => void;
}) {
  return <AttributeValueInput
    attr={attr}
    kind={ruleValueKind(attr)}
    value={value.raw}
    display={value.display}
    statuses={statuses}
    onChange={(raw, display, referenceId) => onChange({ raw, display, ...(referenceId ? { referenceId } : {}) })}
  />;
}
