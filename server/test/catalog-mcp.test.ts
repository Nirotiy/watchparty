import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CATALOG_TOOLS, createCatalogMcp } from "../mcp/catalog-mcp.ts";

/**
 * MCP 面的唯一职责：钉住"Agent 拿不到批准权"这条边界。
 * 批准（`POST .../approval`）是服务端网页上那一下点击，工具表里没有它，
 * 结构变更只能带着已经签好的一次性凭证去执行。
 */
async function ask(lines: string[], expected: number): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen: Array<Record<string, unknown>> = [];
  let buffer = "";
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) seen.push(JSON.parse(line) as Record<string, unknown>);
      index = buffer.indexOf("\n");
    }
    if (seen.length >= expected) settle();
  });
  const server = createCatalogMcp({ input, output, apiBase: "http://127.0.0.1:1", adminToken: "t" });
  const done = server.start();
  input.write(`${lines.join("\n")}\n`);
  await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
  input.end();
  await done;
  return seen;
}

const rpc = (idValue: number, method: string, params?: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id: idValue, method, ...(params ? { params } : {}) });

test("工具表面只有读、草稿写入和带凭证的应用，没有批准", async () => {
  const names = CATALOG_TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [
    "catalog_exclusions", "catalog_exclude", "catalog_unexclude",
    "catalog_read",
    "catalog_scan_read",
    "draft_status",
    "import_preview",
    "import_write_metadata",
    "import_propose_structure",
    "import_apply_metadata",
    "import_apply_approved",
    "catalog_duplicates_read",
    "approvals_read",
    "import_rollback",
  ]);
  // 真正的证据：把每个工具都跑一遍，看它们会打到哪些路由。
  // 红线只有一条 —— 不许 POST 签发/撤销批准的接口；`GET .../approvals` 是读台账，不算。
  const hits: Array<{ name: string; method: string; route: string }> = [];
  for (const tool of CATALOG_TOOLS) {
    const call = async (method: string, route: string) => {
      hits.push({ name: tool.name, method, route });
      return {};
    };
    await tool.run(call as never, {
      libraryId: "lib_anime",
      itemKey: "/Medalist",
      title: "标题",
      approvalToken: "token",
      rollbackOf: "appr_1",
      sourceFiles: ["Medalist/.watchparty.collection.json"],
    });
  }
  const issuesApproval = (hit: { method: string; route: string }) =>
    hit.method === "POST" && /^\/api\/admin\/media-libraries\/[^/]+\/approval(\/revoke)?$/.test(hit.route);
  assert.ok(hits.every((hit) => !issuesApproval(hit)), `MCP 侧出现了批准接口：${JSON.stringify(hits.filter(issuesApproval))}`);
  assert.deepEqual(
    hits.map((hit) => [hit.name, hit.method, hit.route]),
    [
      ["catalog_exclusions", "GET", "/api/admin/media-libraries/lib_anime/exclusions"],
      ["catalog_exclude", "POST", "/api/admin/media-libraries/lib_anime/draft/exclude"],
      ["catalog_unexclude", "POST", "/api/admin/media-libraries/lib_anime/draft/unexclude"],
      ["catalog_read", "GET", "/api/media/catalog?libraryId=lib_anime"],
      ["catalog_scan_read", "GET", "/api/admin/media-libraries/lib_anime/scan"],
      ["draft_status", "GET", "/api/admin/media-libraries/lib_anime/classify?item=%2FMedalist"],
      ["import_preview", "POST", "/api/admin/media-libraries/lib_anime/import/preview"],
      ["import_write_metadata", "POST", "/api/admin/media-libraries/lib_anime/draft/edit"],
      ["import_propose_structure", "POST", "/api/admin/media-libraries/lib_anime/import/structure"],
      ["import_apply_metadata", "POST", "/api/admin/media-libraries/lib_anime/apply"],
      ["import_apply_approved", "POST", "/api/admin/media-libraries/lib_anime/apply-approved"],
      ["catalog_duplicates_read", "GET", "/api/admin/media-libraries/lib_anime/duplicates"],
      ["approvals_read", "GET", "/api/admin/media-libraries/lib_anime/approvals"],
      ["import_rollback", "POST", "/api/admin/media-libraries/lib_anime/rollback"],
    ],
  );
  const apply = CATALOG_TOOLS.find((tool) => tool.name === "import_apply_approved");
  assert.deepEqual(apply?.required, ["libraryId", "approvalToken"], "带结构的那条应用路径必须交凭证");
});

test("stdio 握手：initialize 与 tools/list 有形状，未知方法与坏行有错误", async () => {
  const messages = await ask([
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    rpc(1, "initialize"),
    rpc(2, "tools/list"),
    rpc(3, "catalog/nope"),
    "{not json",
  ], 4);
  const byId = new Map(messages.map((message) => [message.id as number, message]));
  const init = byId.get(1)?.result as { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } };
  assert.equal(init.protocolVersion, "2024-11-05");
  assert.ok(init.capabilities.tools);
  assert.equal(init.serverInfo.name, "watchparty-catalog");
  assert.equal((byId.get(2)?.result as { tools: Array<{ name: string; inputSchema: { type: string } }> }).tools.length, CATALOG_TOOLS.length);
  assert.equal((byId.get(2)?.result as { tools: Array<{ inputSchema: { type: string } }> }).tools[0].inputSchema.type, "object");
  assert.equal((byId.get(3)?.error as { code: number }).code, -32601);
  assert.equal((byId.get(0) ?? messages[messages.length - 1]).error !== undefined, true, "坏 JSON 也要回一条错误而不是崩掉");
});

test("调用未知工具是 JSON-RPC 层的参数错误，不是异常", async () => {
  const messages = await ask([rpc(1, "tools/call", { name: "catalog_approve", arguments: {} })], 1);
  assert.equal((messages[0].error as { code: number }).code, -32602);
});

test("后端不可达时 tools/call 回 isError，不抛异常把会话断掉", async () => {
  const messages = await ask([rpc(1, "tools/call", { name: "draft_status", arguments: { libraryId: "lib_anime" } })], 1);
  const result = messages[0].result as { isError: boolean; content: Array<{ type: string; text: string }> };
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.ok(result.content[0].text.length > 0);
});
