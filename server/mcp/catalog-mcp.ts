import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/**
 * 目录管理的 MCP stdio 服务（换行分隔的 JSON-RPC 2.0，不拉 SDK）。
 *
 * 权限边界是这个文件存在的全部理由：**没有批准用的工具**。批准是服务端网页上那一下
 * 点击，Agent 拿不到，所以它也只能拿着一张已经签好的一次性凭证去执行结构变更。长期
 * admin token 只代表"能调用接口"，不代表"能替人点头"。
 */

const PROTOCOL_VERSION = "2024-11-05";

type ToolSpec = {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  run: (call: ApiCall, args: Record<string, unknown>) => Promise<unknown>;
};

type ApiCall = (method: "GET" | "POST", route: string, body?: Record<string, unknown>) => Promise<unknown>;

const id = { type: "string", description: "媒体库 id，例如 lib_anime" } as const;
const itemKey = { type: "string", description: "草稿卡的键位（通常是库内目录）" } as const;

const stringFields = {
  title: { type: "string" },
  originalTitle: { type: "string" },
  overview: { type: "string" },
  posterUrl: { type: "string" },
  externalDb: { type: "string", description: "bangumi 或 tmdb" },
  externalId: { type: "string", description: "条目 id；必须与 externalDb 成对" },
};

export const CATALOG_TOOLS: ToolSpec[] = [
  {
    name: "catalog_read",
    description: "读取正式卡（标题墙）：列表或单卡详情。只读。",
    properties: { libraryId: id, itemId: { type: "string", description: "给出时读这张卡的详情" }, q: { type: "string" }, cursor: { type: "string" } },
    required: ["libraryId"],
    async run(call, args) {
      if (typeof args.itemId === "string") return call("GET", `/api/media/catalog/${encodeURIComponent(args.itemId)}`);
      const query = new URLSearchParams({ libraryId: String(args.libraryId) });
      if (typeof args.q === "string") query.set("q", args.q);
      if (typeof args.cursor === "string") query.set("cursor", args.cursor);
      return call("GET", `/api/media/catalog?${query.toString()}`);
    },
  },
  {
    name: "catalog_scan_read",
    description: "读取扫描快照（文件数、修订号、枚举时间）。只读。",
    properties: { libraryId: id },
    required: ["libraryId"],
    async run(call, args) {
      return call("GET", `/api/admin/media-libraries/${encodeURIComponent(String(args.libraryId))}/scan`);
    },
  },
  {
    name: "draft_status",
    description: "读取现有草稿、六桶差异与单卡文件/候选。只读，是判断该改什么的起点。",
    properties: { libraryId: id, itemKey },
    required: ["libraryId"],
    async run(call, args) {
      const base = `/api/admin/media-libraries/${encodeURIComponent(String(args.libraryId))}/classify`;
      return typeof args.itemKey === "string" ? call("GET", `${base}?item=${encodeURIComponent(args.itemKey)}`) : call("GET", base);
    },
  },
  {
    name: "import_preview",
    description: "读服务端本地 collection sidecar，按文件集合对账并把元数据写进草稿；结构变更只作为提案返回。",
    properties: { libraryId: id },
    required: ["libraryId"],
    async run(call, args) {
      return call("POST", `/api/admin/media-libraries/${encodeURIComponent(String(args.libraryId))}/import/preview`);
    },
  },
  {
    name: "import_write_metadata",
    description:
      "低风险元数据写入：标题、原标题、年份、简介、海报、外部条目，或从候选里确认一条。改不了文件集合。confirmFromCandidate=true 时走候选确认。",
    properties: {
      libraryId: id,
      itemKey,
      ...stringFields,
      year: { type: "number" },
      confirmFromCandidate: { type: "boolean" },
    },
    required: ["libraryId", "itemKey"],
    async run(call, args) {
      const libraryId = encodeURIComponent(String(args.libraryId));
      const body: Record<string, unknown> = { itemKey: args.itemKey };
      for (const field of Object.keys(stringFields)) if (args[field] !== undefined) body[field] = args[field];
      if (args.year !== undefined) body.year = args.year;
      if (args.confirmFromCandidate === true) return call("POST", `/api/admin/media-libraries/${libraryId}/draft/confirm`, body);
      if (Object.keys(body).length <= 1) throw new Error("没有可写的元数据字段");
      return call("POST", `/api/admin/media-libraries/${libraryId}/draft/edit`, body);
    },
  },
  {
    name: "import_propose_structure",
    description:
      "把 sidecar 表达的结构提案（合并/拆分/换归属）落进草稿。只动草稿，正式卡要等人批准后带凭证应用。sourceFiles 省略则落全部提案。",
    properties: { libraryId: id, sourceFiles: { type: "array", description: "sidecar 文件在根目录下的相对路径清单" } },
    required: ["libraryId"],
    async run(call, args) {
      const body = Array.isArray(args.sourceFiles) ? { sourceFiles: args.sourceFiles.map(String) } : {};
      return call("POST", `/api/admin/media-libraries/${encodeURIComponent(String(args.libraryId))}/import/structure`, body);
    },
  },
  {
    name: "import_apply_metadata",
    description: "应用草稿里**不含结构变更**的那部分。一旦差异里有建卡/删卡/移动，服务端会 409 并给出待批准清单。",
    properties: { libraryId: id, force: { type: "boolean", description: "草稿未判完时是否仍要应用" } },
    required: ["libraryId"],
    async run(call, args) {
      const suffix = args.force === true ? "?force=1" : "";
      return call("POST", `/api/admin/media-libraries/${encodeURIComponent(String(args.libraryId))}/apply${suffix}`);
    },
  },
  {
    name: "import_apply_approved",
    description: "带着网页刚签发的一次性凭证应用结构变更。凭证 48 小时过期、用过即废，内容或修订一变就失效。",
    properties: { libraryId: id, approvalToken: { type: "string", description: "人在服务端网页上批准后拿到的明文凭证" }, force: { type: "boolean" } },
    required: ["libraryId", "approvalToken"],
    async run(call, args) {
      return call("POST", `/api/admin/media-libraries/${encodeURIComponent(String(args.libraryId))}/apply-approved`, {
        approvalToken: args.approvalToken,
        ...(args.force === true ? { force: 1 } : {}),
      });
    },
  },
  {
    name: "catalog_duplicates_read",
    description: "读取墙上的疑似同作（OVA/季度/SP 那类）：证据、建议保留的卡、合并后绑定/集数/海报的去向。服务端只读，不会自动合并。",
    properties: { libraryId: id },
    required: ["libraryId"],
    async run(call, args) {
      return call("GET", `/api/admin/media-libraries/${encodeURIComponent(String(args.libraryId))}/duplicates`);
    },
  },
  {
    name: "approvals_read",
    description: "读取回滚台账：哪一次结构应用留下了可撤的记录、动了哪些键位。绝不返回凭证本体或其哈希。",
    properties: { libraryId: id },
    required: ["libraryId"],
    async run(call, args) {
      return call("GET", `/api/admin/media-libraries/${encodeURIComponent(String(args.libraryId))}/approvals`);
    },
  },
  {
    name: "import_rollback",
    description:
      "带着人工签发的回滚凭证撤掉一次结构应用。凭证来自网页上的 POST .../approval {rollbackOf}；服务端先核对现值，人在那之后动过的卡一张都不会被撤回。",
    properties: {
      libraryId: id,
      rollbackOf: { type: "string", description: "要撤回的那次应用的 approvalId" },
      approvalToken: { type: "string", description: "为这次撤回单独签发的一次性凭证" },
    },
    required: ["libraryId", "rollbackOf", "approvalToken"],
    async run(call, args) {
      return call("POST", `/api/admin/media-libraries/${encodeURIComponent(String(args.libraryId))}/rollback`, {
        rollbackOf: args.rollbackOf,
        approvalToken: args.approvalToken,
      });
    },
  },
];

export function createCatalogMcp(options: {
  apiBase?: string;
  adminToken?: string;
  input?: Readable;
  output?: Writable;
  fetchImpl?: typeof fetch;
}): { start(): Promise<void>; tools: ToolSpec[] } {
  const apiBase = (options.apiBase ?? process.env.WATCHPARTY_API_BASE ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const adminToken = options.adminToken ?? process.env.WATCHPARTY_ADMIN_TOKEN ?? "";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const fetchImpl = options.fetchImpl ?? fetch;

  const call: ApiCall = async (method, route, body) => {
    const response = await fetchImpl(`${apiBase}${route}`, {
      method,
      headers: { ...(adminToken ? { "x-watchparty-admin": adminToken } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record = (payload ?? {}) as Record<string, unknown>;
      const code = typeof record.code === "string" ? record.code : `HTTP_${response.status}`;
      throw new Error(`${code}${typeof record.reason === "string" ? ` (${record.reason})` : ""}`);
    }
    return payload;
  };

  const write = (message: Record<string, unknown>) => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  async function handle(message: Record<string, unknown>): Promise<void> {
    const method = String(message.method ?? "");
    const idValue = message.id;
    if (method === "notifications/initialized" || method.startsWith("notifications/")) return;
    const respond = (result?: unknown, error?: { code: number; message: string }) => {
      if (idValue === undefined) return;
      write(error ? { jsonrpc: "2.0", id: idValue, error } : { jsonrpc: "2.0", id: idValue, result });
    };
    if (method === "initialize") {
      respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "watchparty-catalog", version: "1.0.0" },
      });
      return;
    }
    if (method === "ping") {
      respond({});
      return;
    }
    if (method === "tools/list") {
      respond({
        tools: CATALOG_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { type: "object", properties: tool.properties, ...(tool.required ? { required: tool.required } : {}) },
        })),
      });
      return;
    }
    if (method === "tools/call") {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = CATALOG_TOOLS.find((entry) => entry.name === name);
      if (!tool) {
        respond(undefined, { code: -32602, message: `未知工具：${name || "(空)"}` });
        return;
      }
      try {
        const value = await tool.run(call, args);
        respond({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: false });
      } catch (error) {
        respond({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
      return;
    }
    respond(undefined, { code: -32601, message: `不支持的方法：${method || "(空)"}` });
  }

  return {
    tools: CATALOG_TOOLS,
    async start() {
      const lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "不是合法 JSON" } });
          continue;
        }
        await handle(message);
      }
    },
  };
}

/** 只有直接 `node server/mcp/catalog-mcp.ts` 时才起循环；测试里是被 import 的。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createCatalogMcp({}).start();
}
