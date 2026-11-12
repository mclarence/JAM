import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown from "react-markdown";
import { notify } from "@/lib/notify";

function safeUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

export function ReleaseNotes({ notes }: { notes: string | null }) {
  if (!notes?.trim()) {
    return <p className="text-sm text-muted-foreground">No release notes were provided for this update.</p>;
  }
  return (
    <div className="grid gap-3 break-words text-sm [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3">
      <Markdown
        skipHtml
        urlTransform={safeUrl}
        components={{
          img: () => null,
          a: ({ href, children }) => href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
              onClick={(event) => {
                if (!isTauri()) return;
                event.preventDefault();
                void openUrl(href).catch((e: unknown) => notify.error(e, "Could not open release notes link"));
              }}
            >
              {children}
            </a>
          ) : <span>{children}</span>,
        }}
      >
        {notes}
      </Markdown>
    </div>
  );
}
