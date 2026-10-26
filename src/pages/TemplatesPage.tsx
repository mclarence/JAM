import { Plus, Printer, Tag } from "lucide-react";
import { Designer } from "@/components/labels/Designer";
import { TemplateList } from "@/components/labels/TemplateList";
import { EmptyState } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/store/settings";
import { useTemplates } from "@/store/templates";
import { useUi } from "@/store/ui";

export function TemplatesPage() {
  const { templates, selectedId, create } = useTemplates();
  const labelDefaults = useSettings((s) => s.labelDefaults);
  const navigate = useUi((s) => s.navigate);
  const template = templates.find((t) => t.id === selectedId) ?? templates[0] ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <TemplateList />
      {template ? (
        <Designer key={template.id} template={template} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState icon={<Tag />} title="No label templates">
            <p className="mb-4">Design labels with text, QR codes and Code 128 barcodes bound to asset attributes.</p>
            <div className="flex justify-center gap-2">
              <Button onClick={() => create(labelDefaults)}>
                <Plus /> Create template
              </Button>
              <Button variant="outline" onClick={() => navigate("assets")}>
                <Printer /> Go to assets
              </Button>
            </div>
          </EmptyState>
        </div>
      )}
    </div>
  );
}
