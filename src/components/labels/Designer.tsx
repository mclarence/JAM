import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import { Rnd } from "react-rnd";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Barcode,
  Bold,
  Braces,
  ChevronsUpDown,
  Grid3x3,
  Italic,
  Loader2,
  QrCode,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { assetsApi } from "@/api/assets";
import { useAttributes, useConnection, useReferenceSearch } from "@/api/queries";
import type { AssetObject } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/overlays";
import { Label, Separator, Switch } from "@/components/ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebounce } from "@/hooks/useDebounce";
import { cn } from "@/lib/utils";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";
import { useUi } from "@/store/ui";
import { LabelSvg } from "./LabelSvg";
import {
  autoFitGrid,
  formatUnit,
  newBarcodeElement,
  newTextElement,
  PAPER_MM,
  PX_PER_MM,
  toMm,
  type BarcodeElement,
  type LabelElement,
  type LabelTemplate,
  type PaperSize,
  type SheetLayout,
  type TextElement,
  type Unit,
} from "./model";
import { identityResolver, makeResolver, placeholderTokens } from "./placeholders";
import { toggleStyle, type StyleKey } from "./richText";

type PaletteItem = { kind: "text" } | { kind: "qrcode" } | { kind: "code128" } | { kind: "token"; token: string };

const round = (v: number, step: number) => Math.round(v / step) * step;

export function Designer({ template }: { template: LabelTemplate }) {
  const { update, updateElement, addElement, removeElement } = useTemplates();
  const objectTypeId = useSettings((s) => s.objectTypeId);
  const connection = useConnection();
  const attrs = useAttributes(objectTypeId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(2);
  const [snap, setSnap] = useState(true);
  const [gridMm, setGridMm] = useState(1);
  const [useSample, setUseSample] = useState(true);
  const [dragging, setDragging] = useState<PaletteItem | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const sampleFirst = useQuery({
    queryKey: ["sampleObject", objectTypeId],
    queryFn: async () => (await assetsApi.searchObjects(`objectTypeId = ${Number(objectTypeId)}`, 0, 1)).values[0] ?? null,
    enabled: !!connection.data && !!objectTypeId,
    staleTime: 5 * 60_000,
  });
  const previewId = useUi((s) => s.previewObjectId);
  const setPreviewId = useUi((s) => s.setPreviewObjectId);
  const chosen = useQuery({
    queryKey: ["previewObject", previewId],
    queryFn: () => assetsApi.getObject(previewId!),
    enabled: !!connection.data && !!previewId,
    staleTime: 5 * 60_000,
  });
  const sample = previewId ? chosen : sampleFirst;

  // A choice made for another object type no longer applies.
  useEffect(() => {
    if (chosen.data && objectTypeId && chosen.data.objectType.id !== objectTypeId) setPreviewId(null);
  }, [chosen.data, objectTypeId, setPreviewId]);

  const resolve = useMemo(
    () => (useSample && sample.data ? makeResolver(sample.data, attrs.data ?? []) : identityResolver),
    [useSample, sample.data, attrs.data],
  );

  const scale = PX_PER_MM * zoom;
  const selected = template.elements.find((e) => e.id === selectedId) ?? null;
  const tokens = placeholderTokens(attrs.data ?? []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected) return;
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable], [role=combobox]")) return;
      const step = e.shiftKey ? 5 : snap ? gridMm : 0.5;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeElement(template.id, selected.id);
        setSelectedId(null);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        updateElement(template.id, selected.id, {
          x: Math.min(Math.max(0, selected.x + dx), template.width - selected.w),
          y: Math.min(Math.max(0, selected.y + dy), template.height - selected.h),
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, snap, gridMm, template.id, template.width, template.height, removeElement, updateElement]);

  const createFromPalette = (item: PaletteItem, x = 2, y = 2): LabelElement => {
    const pos = { x, y };
    switch (item.kind) {
      case "text":
        return newTextElement({ ...pos, content: "Text" });
      case "qrcode":
        return newBarcodeElement("qrcode", pos);
      case "code128":
        return newBarcodeElement("code128", pos);
      case "token":
        return newTextElement({ ...pos, content: `\${${item.token}}` });
    }
  };

  const place = (item: PaletteItem, x?: number, y?: number) => {
    const el = createFromPalette(item, x, y);
    el.w = Math.min(el.w, template.width);
    el.h = Math.min(el.h, template.height);
    el.x = Math.min(Math.max(0, el.x), template.width - el.w);
    el.y = Math.min(Math.max(0, el.y), template.height - el.h);
    addElement(template.id, el);
    setSelectedId(el.id);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const rect = e.active.rect.current.translated;
    if (e.over?.id !== "canvas" || !rect) return;
    const item = e.active.data.current as PaletteItem;
    let x = (rect.left - e.over.rect.left) / scale;
    let y = (rect.top - e.over.rect.top) / scale;
    if (snap) {
      x = round(x, gridMm);
      y = round(y, gridMm);
    }
    place(item, x, y);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setDragging(e.active.data.current as PaletteItem)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        <div className="flex w-52 shrink-0 flex-col gap-4 overflow-auto border-r p-3">
          <div className="grid gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Elements</p>
            <PaletteButton item={{ kind: "text" }} icon={<Type />} label="Text" onClick={place} />
            <PaletteButton item={{ kind: "qrcode" }} icon={<QrCode />} label="QR Code" onClick={place} />
            <PaletteButton item={{ kind: "code128" }} icon={<Barcode />} label="Code 128" onClick={place} />
          </div>
          <div className="grid gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Attributes</p>
            {!objectTypeId && <p className="text-xs text-muted-foreground">Select an object type in Settings.</p>}
            {tokens.map((t) => (
              <PaletteButton key={t} item={{ kind: "token", token: t }} icon={<Braces />} label={t} onClick={place} />
            ))}
          </div>
        </div>

        {/* Canvas */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Tooltip content="Zoom out">
              <Button variant="ghost" size="iconSm" onClick={() => setZoom((z) => Math.max(0.5, z - 0.5))} aria-label="Zoom out">
                <ZoomOut />
              </Button>
            </Tooltip>
            <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
            <Tooltip content="Zoom in">
              <Button variant="ghost" size="iconSm" onClick={() => setZoom((z) => Math.min(8, z + 0.5))} aria-label="Zoom in">
                <ZoomIn />
              </Button>
            </Tooltip>
            <Separator orientation="vertical" className="mx-1 h-5" />
            <Label className="flex items-center gap-2 text-xs font-normal">
              <Switch checked={snap} onCheckedChange={setSnap} /> <Grid3x3 className="size-3.5" /> Snap
            </Label>
            <Select value={String(gridMm)} onValueChange={(v) => setGridMm(Number(v))}>
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[0.5, 1, 2, 5].map((g) => (
                  <SelectItem key={g} value={String(g)}>
                    {g} mm
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex-1" />
            <Label className="flex items-center gap-2 text-xs font-normal">
              <Switch checked={useSample} onCheckedChange={setUseSample} disabled={!sample.data} /> Preview
            </Label>
            <PreviewPicker
              objectTypeId={objectTypeId}
              current={sample.data ?? null}
              custom={!!previewId}
              disabled={!connection.data || !objectTypeId}
              onPick={setPreviewId}
            />
          </div>

          <div className="flex-1 overflow-auto bg-muted/40 p-10" onMouseDown={(e) => e.target === e.currentTarget && setSelectedId(null)}>
            <Canvas template={template} scale={scale} gridMm={gridMm} snap={snap}>
              <LabelSvg template={template} resolve={resolve} className="pointer-events-none absolute inset-0" style={{ width: "100%", height: "100%" }} />
              {template.elements.map((el) => {
                const isSel = el.id === selectedId;
                const g = snap ? gridMm * scale : 1;
                return (
                  <Rnd
                    key={el.id}
                    bounds="parent"
                    size={{ width: el.w * scale, height: el.h * scale }}
                    position={{ x: el.x * scale, y: el.y * scale }}
                    dragGrid={[g, g]}
                    resizeGrid={[g, g]}
                    lockAspectRatio={el.kind === "barcode" && el.symbology === "qrcode"}
                    enableResizing={isSel}
                    onMouseDown={() => setSelectedId(el.id)}
                    onDragStop={(_e, d) => {
                      const step = snap ? gridMm : 0.1;
                      updateElement(template.id, el.id, { x: round(d.x / scale, step), y: round(d.y / scale, step) });
                    }}
                    onResizeStop={(_e, _dir, ref, _delta, pos) => {
                      const step = snap ? gridMm : 0.1;
                      updateElement(template.id, el.id, {
                        x: round(pos.x / scale, step),
                        y: round(pos.y / scale, step),
                        w: Math.max(step, round(ref.offsetWidth / scale, step)),
                        h: Math.max(step, round(ref.offsetHeight / scale, step)),
                      });
                    }}
                    className={cn(
                      "outline-offset-0",
                      isSel ? "outline outline-1 outline-blue-500" : "hover:outline hover:outline-1 hover:outline-dashed hover:outline-blue-400/70",
                    )}
                    resizeHandleClasses={
                      isSel
                        ? Object.fromEntries(
                            ["topLeft", "topRight", "bottomLeft", "bottomRight"].map((k) => [
                              k,
                              "!size-2.5 rounded-sm border border-blue-500 bg-white",
                            ]),
                          )
                        : undefined
                    }
                  />
                );
              })}
            </Canvas>
            <p className="mt-3 text-xs text-muted-foreground">
              {formatUnit(template.width, template.unit)} × {formatUnit(template.height, template.unit)} {template.unit} · Drag
              elements from the palette, arrows to nudge (Shift = 5 mm), Delete to remove.
            </p>
          </div>
        </div>

        {/* Inspector */}
        <div className="w-72 shrink-0 overflow-auto border-l p-4">
          {selected ? (
            <ElementInspector
              el={selected}
              unit={template.unit}
              tokens={tokens}
              onChange={(patch) => updateElement(template.id, selected.id, patch)}
              onDelete={() => {
                removeElement(template.id, selected.id);
                setSelectedId(null);
              }}
            />
          ) : (
            <TemplateInspector template={template} onChange={(patch) => update(template.id, patch)} />
          )}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="rounded border border-blue-500 bg-blue-500/10 px-2 py-1 text-xs shadow">
            {dragging.kind === "token" ? `\${${dragging.token}}` : dragging.kind}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function Canvas({
  template,
  scale,
  gridMm,
  snap,
  children,
}: {
  template: LabelTemplate;
  scale: number;
  gridMm: number;
  snap: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "canvas" });
  const g = gridMm * scale;
  return (
    <div
      ref={setNodeRef}
      className={cn("relative bg-white shadow-lg ring-1 ring-black/10", isOver && "ring-2 ring-blue-500")}
      style={{
        width: template.width * scale,
        height: template.height * scale,
        backgroundImage: snap
          ? "linear-gradient(to right, rgba(59,130,246,0.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(59,130,246,0.12) 1px, transparent 1px)"
          : undefined,
        backgroundSize: snap ? `${g}px ${g}px` : undefined,
      }}
    >
      {children}
    </div>
  );
}

function PaletteButton({
  item,
  icon,
  label,
  onClick,
}: {
  item: PaletteItem;
  icon: React.ReactNode;
  label: string;
  onClick: (item: PaletteItem) => void;
}) {
  const id = item.kind === "token" ? `token:${item.token}` : item.kind;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data: item });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={() => onClick(item)}
      className={cn(
        "flex cursor-grab items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-sm hover:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        isDragging && "opacity-50",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function UnitField({ label, mm, unit, onChange, min = 0 }: { label: string; mm: number; unit: Unit; onChange: (mm: number) => void; min?: number }) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs text-muted-foreground">
        {label} ({unit})
      </Label>
      <NumberInput className="h-8" min={min} value={formatUnit(mm, unit)} onCommit={(n) => onChange(toMm(n, unit))} />
    </div>
  );
}

function ElementInspector({
  el,
  unit,
  tokens,
  onChange,
  onDelete,
}: {
  el: LabelElement;
  unit: Unit;
  tokens: string[];
  onChange: (patch: Partial<LabelElement>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {el.kind === "text" ? "Text" : el.symbology === "qrcode" ? "QR Code" : "Code 128"}
        </h3>
        <Button variant="ghost" size="iconSm" onClick={onDelete} aria-label="Delete element">
          <Trash2 />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <UnitField label="X" mm={el.x} unit={unit} onChange={(x) => onChange({ x })} />
        <UnitField label="Y" mm={el.y} unit={unit} onChange={(y) => onChange({ y })} />
        <UnitField label="Width" mm={el.w} unit={unit} onChange={(w) => onChange({ w })} />
        <UnitField label="Height" mm={el.h} unit={unit} onChange={(h) => onChange({ h })} />
      </div>
      <Separator />
      {el.kind === "text" ? (
        <TextProps el={el} tokens={tokens} onChange={onChange} />
      ) : (
        <BarcodeProps el={el} tokens={tokens} onChange={onChange} />
      )}
    </div>
  );
}

function PreviewPicker({
  objectTypeId,
  current,
  custom,
  disabled,
  onPick,
}: {
  objectTypeId: string | null;
  current: AssetObject | null;
  custom: boolean;
  disabled: boolean;
  onPick: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const debounced = useDebounce(term, 300);
  const results = useReferenceSearch(objectTypeId ?? undefined, debounced);
  const pick = (id: string | null) => {
    onPick(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-64" disabled={disabled}>
          <span className="truncate">{current ? `${current.objectKey} \u00b7 ${current.label}` : "Choose asset"}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput autoFocus value={term} onValueChange={setTerm} placeholder="Search by key or name…" />
          <CommandList>
            {results.isFetching && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Searching…
              </div>
            )}
            {!results.isFetching && <CommandEmpty>No matches.</CommandEmpty>}
            {custom && (
              <CommandGroup>
                <CommandItem value="__first" onSelect={() => pick(null)}>
                  Use the first asset
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Assets">
              {results.data?.map((o) => (
                <CommandItem key={o.id} value={o.id} onSelect={() => pick(o.id)}>
                  <span className="truncate">{o.label}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{o.objectKey}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TokenInsert({ tokens, onInsert }: { tokens: string[]; onInsert: (token: string) => void }) {
  return (
    <Select value="" onValueChange={(t) => onInsert(`\${${t}}`)}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder="Insert attribute…" />
      </SelectTrigger>
      <SelectContent>
        {tokens.map((t) => (
          <SelectItem key={t} value={t}>
            {t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TextProps({ el, tokens, onChange }: { el: TextElement; tokens: string[]; onChange: (p: Partial<TextElement>) => void }) {
  const toggle = "data-[on=true]:bg-accent data-[on=true]:text-foreground";
  const area = useRef<HTMLTextAreaElement>(null);
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => setHasSelection(false), [el.id]);
  const syncSelection = (e: React.SyntheticEvent<HTMLTextAreaElement>) =>
    setHasSelection(e.currentTarget.selectionStart !== e.currentTarget.selectionEnd);

  const applyStyle = (key: StyleKey) => {
    const ta = area.current;
    if (!ta || ta.selectionStart === ta.selectionEnd) return;
    const r = toggleStyle(el.content, ta.selectionStart, ta.selectionEnd, key);
    onChange({ content: r.content });
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(r.start, r.end);
      setHasSelection(r.start !== r.end);
    });
  };
  const styleButtons: { key: StyleKey; label: string; icon: React.ReactNode }[] = [
    { key: "bold", label: "Bold (Ctrl+B)", icon: <Bold /> },
    { key: "italic", label: "Italic (Ctrl+I)", icon: <Italic /> },
    { key: "underline", label: "Underline (Ctrl+U)", icon: <Underline /> },
    { key: "strike", label: "Strikethrough (Ctrl+Shift+X)", icon: <Strikethrough /> },
  ];
  const shortcuts: Record<string, StyleKey> = { b: "bold", i: "italic", u: "underline" };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Content</Label>
          <div className="flex gap-0.5">
            {styleButtons.map((b) => (
              <Tooltip key={b.key} content={`${b.label}: applies to the selected text`}>
                <Button
                  type="button"
                  variant="ghost"
                  size="iconSm"
                  aria-label={b.label}
                  disabled={!hasSelection}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyStyle(b.key)}
                >
                  {b.icon}
                </Button>
              </Tooltip>
            ))}
          </div>
        </div>
        <Textarea
          ref={area}
          value={el.content}
          rows={3}
          onChange={(e) => onChange({ content: e.target.value })}
          onSelect={syncSelection}
          onKeyUp={syncSelection}
          onMouseUp={syncSelection}
          onFocus={syncSelection}
          onKeyDown={(e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const key = e.shiftKey && e.key.toLowerCase() === "x" ? "strike" : e.shiftKey ? undefined : shortcuts[e.key.toLowerCase()];
            if (!key) return;
            e.preventDefault();
            applyStyle(key);
          }}
          className="font-mono text-xs"
        />
        <TokenInsert tokens={tokens} onInsert={(t) => onChange({ content: el.content + t })} />
        <p className="text-xs text-muted-foreground">
          Select text, then use the buttons to style just that part. Markup: **bold** ''italic'' __underline__
          ~~strike~~. Put a backslash before a marker to print it literally.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground">{el.fit === "shrink" ? "Max font size (pt)" : "Font size (pt)"}</Label>
          <NumberInput className="h-8" min={2} max={200} value={el.fontSize} onCommit={(fontSize) => onChange({ fontSize })} />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground">Line height</Label>
          <NumberInput className="h-8" min={0.8} max={3} step={0.1} value={el.lineHeight} onCommit={(lineHeight) => onChange({ lineHeight })} />
        </div>
      </div>
      <div className="grid gap-1">
        <Label className="text-xs text-muted-foreground">When text is too big</Label>
        <Select value={el.fit ?? "wrap"} onValueChange={(v) => onChange({ fit: v as NonNullable<TextElement["fit"]> })}>
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="wrap">Wrap onto more lines</SelectItem>
            <SelectItem value="shrink">Shrink font to fit</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-1">
        {(["left", "center", "right"] as const).map((a) => (
          <Button key={a} variant="outline" size="iconSm" data-on={el.align === a} className={toggle} onClick={() => onChange({ align: a })} aria-label={`Align ${a}`}>
            {a === "left" ? <AlignLeft /> : a === "center" ? <AlignCenter /> : <AlignRight />}
          </Button>
        ))}
      </div>
    </div>
  );
}

function BarcodeProps({ el, tokens, onChange }: { el: BarcodeElement; tokens: string[]; onChange: (p: Partial<BarcodeElement>) => void }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label className="text-xs text-muted-foreground">Symbology</Label>
        <Select value={el.symbology} onValueChange={(v) => onChange({ symbology: v as BarcodeElement["symbology"] })}>
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="qrcode">QR Code</SelectItem>
            <SelectItem value="code128">Code 128</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label className="text-xs text-muted-foreground">Encoded value</Label>
        <Input value={el.value} onChange={(e) => onChange({ value: e.target.value })} className="h-8 font-mono text-xs" />
        <TokenInsert tokens={tokens} onInsert={(t) => onChange({ value: t })} />
      </div>
      {el.symbology === "code128" && (
        <Label className="flex items-center gap-2 text-sm font-normal">
          <Switch checked={el.showText} onCheckedChange={(showText) => onChange({ showText })} /> Show human-readable text
        </Label>
      )}
    </div>
  );
}

function TemplateInspector({ template, onChange }: { template: LabelTemplate; onChange: (patch: Partial<LabelTemplate>) => void }) {
  const layout = template.layout;
  const sheet = layout.mode === "sheet" ? layout : null;
  const setSheet = (patch: Partial<Extract<SheetLayout, { mode: "sheet" }>>) => sheet && onChange({ layout: { ...sheet, ...patch } });

  return (
    <div className="grid gap-4">
      <h3 className="text-sm font-medium">Template</h3>
      <div className="grid gap-1">
        <Label className="text-xs text-muted-foreground">Name</Label>
        <Input className="h-8" value={template.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs text-muted-foreground">Units</Label>
        <Select value={template.unit} onValueChange={(v) => onChange({ unit: v as Unit })}>
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mm">Millimetres</SelectItem>
            <SelectItem value="in">Inches</SelectItem>
            <SelectItem value="px">Pixels (96 dpi)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <UnitField label="Label width" mm={template.width} unit={template.unit} min={1} onChange={(width) => onChange({ width })} />
        <UnitField label="Label height" mm={template.height} unit={template.unit} min={1} onChange={(height) => onChange({ height })} />
      </div>
      <Separator />
      <div className="grid gap-1">
        <Label className="text-xs text-muted-foreground">Page layout</Label>
        <Select
          value={layout.mode}
          onValueChange={(mode) => {
            if (mode === "single") return onChange({ layout: { mode: "single" } });
            const next: Extract<SheetLayout, { mode: "sheet" }> = {
              mode: "sheet",
              paper: "A4",
              orientation: "portrait",
              columns: 1,
              rows: 1,
              marginTop: 10,
              marginLeft: 10,
              gapX: 2,
              gapY: 2,
            };
            onChange({ layout: { ...next, ...autoFitGrid(template, next) } });
          }}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="single">Single label per page (thermal / roll)</SelectItem>
            <SelectItem value="sheet">Grid on sheet (A3 / A4 / A5)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {sheet && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Paper</Label>
              <Select value={sheet.paper} onValueChange={(paper) => setSheet({ paper: paper as PaperSize })}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PAPER_MM) as PaperSize[]).map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Orientation</Label>
              <Select value={sheet.orientation} onValueChange={(o) => setSheet({ orientation: o as "portrait" | "landscape" })}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="portrait">Portrait</SelectItem>
                  <SelectItem value="landscape">Landscape</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Columns</Label>
              <NumberInput className="h-8" min={1} step={1} value={sheet.columns} onCommit={(n) => setSheet({ columns: Math.round(n) })} />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Rows</Label>
              <NumberInput className="h-8" min={1} step={1} value={sheet.rows} onCommit={(n) => setSheet({ rows: Math.round(n) })} />
            </div>
            <UnitField label="Top margin" mm={sheet.marginTop} unit={template.unit} onChange={(marginTop) => setSheet({ marginTop })} />
            <UnitField label="Left margin" mm={sheet.marginLeft} unit={template.unit} onChange={(marginLeft) => setSheet({ marginLeft })} />
            <UnitField label="Column gap" mm={sheet.gapX} unit={template.unit} onChange={(gapX) => setSheet({ gapX })} />
            <UnitField label="Row gap" mm={sheet.gapY} unit={template.unit} onChange={(gapY) => setSheet({ gapY })} />
          </div>
          <Button variant="outline" size="sm" onClick={() => setSheet(autoFitGrid(template, sheet))}>
            Auto-fit grid to paper
          </Button>
        </>
      )}
    </div>
  );
}
