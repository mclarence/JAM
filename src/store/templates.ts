import { create } from "zustand";
import { persist } from "zustand/middleware";
import { newTemplate, type LabelElement, type LabelTemplate } from "@/components/labels/model";
import { fileStorage } from "./persist";

interface TemplatesState {
  templates: LabelTemplate[];
  defaultTemplateId: string | null;
  selectedId: string | null;

  create: (defaults: { unit: LabelTemplate["unit"]; width: number; height: number }) => string;
  duplicate: (id: string) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  setDefault: (id: string) => void;
  update: (id: string, patch: Partial<Omit<LabelTemplate, "id">>) => void;
  updateElement: (id: string, elementId: string, patch: Partial<LabelElement>) => void;
  addElement: (id: string, el: LabelElement) => void;
  removeElement: (id: string, elementId: string) => void;
}

export const useTemplates = create<TemplatesState>()(
  persist(
    (set, get) => {
      const patchTemplate = (id: string, fn: (t: LabelTemplate) => LabelTemplate) =>
        set((s) => ({ templates: s.templates.map((t) => (t.id === id ? { ...fn(t), updatedAt: Date.now() } : t)) }));

      return {
        templates: [],
        defaultTemplateId: null,
        selectedId: null,

        create: (defaults) => {
          const t = newTemplate(`Template ${get().templates.length + 1}`, defaults);
          set((s) => ({
            templates: [...s.templates, t],
            selectedId: t.id,
            defaultTemplateId: s.defaultTemplateId ?? t.id,
          }));
          return t.id;
        },
        duplicate: (id) => {
          const src = get().templates.find((t) => t.id === id);
          if (!src) return;
          const copy: LabelTemplate = {
            ...structuredClone(src),
            id: crypto.randomUUID(),
            name: `${src.name} (copy)`,
            updatedAt: Date.now(),
          };
          copy.elements = copy.elements.map((e) => ({ ...e, id: crypto.randomUUID() }));
          set((s) => ({ templates: [...s.templates, copy], selectedId: copy.id }));
        },
        rename: (id, name) => patchTemplate(id, (t) => ({ ...t, name })),
        remove: (id) =>
          set((s) => {
            const templates = s.templates.filter((t) => t.id !== id);
            return {
              templates,
              selectedId: s.selectedId === id ? (templates[0]?.id ?? null) : s.selectedId,
              defaultTemplateId: s.defaultTemplateId === id ? (templates[0]?.id ?? null) : s.defaultTemplateId,
            };
          }),
        select: (selectedId) => set({ selectedId }),
        setDefault: (defaultTemplateId) => set({ defaultTemplateId }),
        update: (id, patch) => patchTemplate(id, (t) => ({ ...t, ...patch })),
        updateElement: (id, elementId, patch) =>
          patchTemplate(id, (t) => ({
            ...t,
            elements: t.elements.map((e) => (e.id === elementId ? ({ ...e, ...patch } as LabelElement) : e)),
          })),
        addElement: (id, el) => patchTemplate(id, (t) => ({ ...t, elements: [...t.elements, el] })),
        removeElement: (id, elementId) =>
          patchTemplate(id, (t) => ({ ...t, elements: t.elements.filter((e) => e.id !== elementId) })),
      };
    },
    {
      name: "templates",
      storage: fileStorage("templates.json"),
      version: 1,
      partialize: (s) => ({ templates: s.templates, defaultTemplateId: s.defaultTemplateId }),
    },
  ),
);
