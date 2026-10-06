import { createRoot } from "react-dom/client"
import { CatalogDraft } from "../../src/components/catalog-draft"
import "../../src/index.css"

// UI fixture transport only; native whitelist and approval injection are tested separately.
window.watchpartyDesktop = {
  runtime: "electron",
  listen: () => () => {},
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (command !== "mediaRequest") throw new Error("fixture_command_not_allowed")
    const reply = await fetch(`/__fixture${String(args.path)}${args.query ? `?${String(args.query)}` : ""}`, {
      method: String(args.method), headers: { "Content-Type": "application/json" },
      ...(args.body ? { body: JSON.stringify(args.body) } : {}),
    })
    return { status: reply.status, body: await reply.text() } as T
  },
}
createRoot(document.getElementById("root")!).render(<main style={{ background: "#000", color: "#fff", padding: 16 }}><CatalogDraft libraryId="lib_anime" libraryName="Anime" admin /></main>)
