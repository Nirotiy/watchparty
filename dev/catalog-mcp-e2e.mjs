// MCP 面的端到端走查：在**真实库的副本**上把每个工具真打一遍，包括写类工具。
// 跑法：NO_PROXY=127.0.0.1,localhost,::1 node --experimental-strip-types dev/catalog-mcp-e2e.mjs [lib_anime]
//
// 这个脚本自己扮"人在网页上点批准"（带 `x-watchparty-approval` 头直接打 HTTP）。
// 它验的是**接口链路通不通**，不验权限边界 —— 边界由 `server/test/catalog-mcp.test.ts`
// 钉：MCP 的工具表里没有批准接口，且它拿不到那把密钥。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createBackend } from "../server/app.ts";

// chdir 之后相对路径就指向临时目录了，所以入口要在进目录前定死。
const mcpEntry = fileURLToPath(new URL("../server/mcp/catalog-mcp.ts", import.meta.url));

const libraryId = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "lib_anime";
const approvalSecret = "e2e-only-approval-secret-0123456789";
process.env.WATCHPARTY_CATALOG_APPROVAL_SECRET = approvalSecret;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "wp-mcp-e2e-"));
fs.mkdirSync(path.join(work, "data"), { recursive: true });
const source = path.join(process.cwd(), "data", "watchparty-catalog.sqlite");
for (const suffix of ["", "-wal", "-shm"]) {
  if (fs.existsSync(`${source}${suffix}`)) fs.copyFileSync(`${source}${suffix}`, path.join(work, "data", `watchparty-catalog.sqlite${suffix}`));
}
process.chdir(work);
console.log(`副本：${path.join(work, "data", "watchparty-catalog.sqlite")}（原库不动）`);

const backend = createBackend({ port: 0, serveStatic: false, fetchPoster: async () => undefined, trustLibraryAdminLoopback: false, libraryAdminToken: "e2e-admin-token" });
await backend.start();
const base = `http://127.0.0.1:${backend.port}`;

const http = async (method, route, body, withSecret = false) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "x-watchparty-admin": "e2e-admin-token", ...(withSecret ? { "x-watchparty-approval": approvalSecret } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const mcp = spawn(process.execPath, ["--experimental-strip-types", mcpEntry], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, WATCHPARTY_API_BASE: base, WATCHPARTY_ADMIN_TOKEN: "e2e-admin-token", NODE_USE_ENV_PROXY: "" },
});
const pending = new Map();
let seq = 0;
readline.createInterface({ input: mcp.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  entry.resolve(message);
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} 60 秒没回音`));
    }, 60000);
  });

// 墙上的内容摘要：撤回之后必须和撤回之前逐字段一致，"差异数字变小"不算证明。
const wallDigest = () => {
  const reader = new DatabaseSync(path.join(work, "data", "watchparty-catalog.sqlite"), { readOnly: true });
  try {
    const rows = reader
      .prepare(
        "SELECT i.id, i.item_key, i.title, i.status, i.confirmed_by, i.external_id, (SELECT COUNT(*) FROM catalog_children c WHERE c.item_id = i.id) files FROM catalog_items i WHERE i.library_id = ? ORDER BY i.id",
      )
      .all(libraryId);
    return { hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16), cards: rows.length };
  } finally {
    reader.close();
  }
};

const results = [];
const tool = async (name, args) => {
  const message = await rpc("tools/call", { name, arguments: args });
  if (message.error) {
    results.push([name, "JSON-RPC 错误", message.error.message]);
    throw new Error(`${name}: ${message.error.message}`);
  }
  const payload = message.result;
  const text = payload.content?.[0]?.text ?? "";
  if (payload.isError) {
    results.push([name, "isError", text]);
    throw new Error(`${name} 失败：${text}`);
  }
  const value = JSON.parse(text);
  results.push([name, "ok", typeof value.approvalToken === "string" ? "<token>" : summarize(value)]);
  return value;
};
const summarize = (value) => {
  if (Array.isArray(value.items)) return `items ${value.items.length}`;
  if (typeof value.groups === "number") return `groups ${value.groups}`;
  if (typeof value.cards === "number") return `cards ${value.cards}${typeof value.written?.length === "number" ? ` / 写 ${value.written.length}` : ""}`;
  if (typeof value.files === "number") return `files ${value.files}`;
  return Object.keys(value).slice(0, 5).join(",");
};

try {
  await rpc("initialize");
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await rpc("tools/list");
  console.log(`\n工具 ${listed.result.tools.length} 个：${listed.result.tools.map((entry) => entry.name).join(", ")}`);

  await tool("draft_status", { libraryId });
  const scan = await tool("catalog_scan_read", { libraryId });
  await tool("catalog_read", { libraryId });

  // 1) 从当前草稿导出 sidecar，再人为拆出一个集合，让 preview 真的看到结构提案。
  const exported = await http("POST", `/api/admin/media-libraries/${libraryId}/import/export`);
  console.log(`\nHTTP import/export → ${exported.status}，${exported.body?.written?.length} 个文件`);
  const root = path.join(work, "data", "catalog-sidecars", libraryId);
  const pick = (exported.body?.written ?? [])
    .map((relative) => ({ relative, full: path.join(root, relative) }))
    .find((entry) => {
      try {
        return JSON.parse(fs.readFileSync(entry.full, "utf8")).members.length >= 2;
      } catch {
        return false;
      }
    });
  if (!pick) {
    console.log("这个库没有 ≥2 个文件的集合，结构走查跳过（其余工具照常跑）");
  } else {
    const doc = JSON.parse(fs.readFileSync(pick.full, "utf8"));
    const [head, ...tail] = doc.members;
    const second = { ...doc, collectionId: "e2e-part-2", title: `${doc.title} 第二部分`, members: tail };
    fs.writeFileSync(pick.full, JSON.stringify({ ...doc, collectionId: "e2e-part-1", title: `${doc.title} 第一部分`, members: [head] }, null, 2));
    fs.writeFileSync(path.join(path.dirname(pick.full), "e2e-part-2.watchparty.collection.json"), JSON.stringify(second, null, 2));
    console.log(`拆集合：${pick.relative} → 第一文件留给原集合，其余 ${tail.length} 个另立一份`);

    const preview = await tool("import_preview", { libraryId });
    console.log(`  preview：写 ${preview.written.length} 张、提案 ${preview.proposals.length} 条、冲突 ${preview.conflicts.length} 条、人工决定保住 ${preview.protectedCards.length} 张`);
    for (const row of preview.protectedCards) console.log(`    没改的这张：${row.itemKey.slice(0, 60)}…（${row.reason}）`);
    const structure = await tool("import_propose_structure", { libraryId });
    console.log(`  structure：${structure.applied.map((row) => `${row.sourceFile.split("/").pop()}=${row.result}`).join(", ")}`);
    const afterPreview = await tool("import_preview", { libraryId });
    console.log(`  再 preview：提案剩 ${afterPreview.proposals.length} 条`);

    // 2) 人在网页上点批准（本脚本带密钥直打 HTTP），MCP 只能拿这张凭证去执行。
    const denied = await http("POST", `/api/admin/media-libraries/${libraryId}/approval`, { approvedBy: "e2e-no-secret" });
    console.log(`\n不带密钥的批准 → ${denied.status} ${(denied.body?.code ?? "")}`);
    const beforeApply = wallDigest();
    console.log(`应用前墙上 ${beforeApply.cards} 张卡，内容摘要 ${beforeApply.hash}`);
    const granted = await http("POST", `/api/admin/media-libraries/${libraryId}/approval`, { approvedBy: "e2e-web" }, true);
    console.log(`带密钥的批准 → ${granted.status} ${granted.body?.approvalId}，待批准 ＋${granted.body?.structural?.added?.length ?? "-"} －${granted.body?.structural?.dropped?.length ?? "-"} ↔${granted.body?.structural?.moved?.length ?? "-"} ⚑${granted.body?.structural?.drift?.length ?? "-"}`);
    const applied = await tool("import_apply_approved", { libraryId, approvalToken: granted.body.approvalToken, force: true });
    console.log(`  apply-approved → 卡 ${applied.cards} 新建 ${applied.created} 未判定不动绑定 ${applied.deferred}，可撤回=${applied.rollbackAvailable}`);
    const replay = await http("POST", `/api/admin/media-libraries/${libraryId}/apply-approved`, { approvalToken: granted.body.approvalToken, force: true });
    console.log(`  同一张凭证重放 → ${replay.status} ${replay.body?.code} ${(replay.body?.reason ?? "")}`);

    // 3) 撤回：再批一次（批的是撤回这个动作），MCP 带凭证执行。
    const ledger = await tool("approvals_read", { libraryId });
    const target = ledger.items.find((row) => row.rollbackAvailable);
    console.log(`\n台账 ${ledger.items.length} 行，可撤回的那条=${target?.approvalId ?? "没有"}`);
    const rolledBackPlan = await http("POST", `/api/admin/media-libraries/${libraryId}/approval`, { rollbackOf: target.approvalId, approvedBy: "e2e-web" }, true);
    console.log(`批准撤回 → ${rolledBackPlan.status} ${rolledBackPlan.body?.approvalId}，撤回单 keys=${JSON.stringify(rolledBackPlan.body?.rollback?.keys)}`);
    const rolled = await tool("import_rollback", { libraryId, rollbackOf: target.approvalId, approvalToken: rolledBackPlan.body.approvalToken });
    console.log(`  rollback → 恢复 ${rolled.restored} 张、撤掉 ${rolled.removed} 张`);
    const diff = await http("GET", `/api/admin/media-libraries/${libraryId}/classify`);
    const afterRollback = wallDigest();
    console.log(`  撤回后差异：一致 ${diff.body?.diff?.unchanged} ＋${diff.body?.diff?.added?.length} －${diff.body?.diff?.dropped?.length}`);
    console.log(`  墙回到应用前的样子？摘要 ${beforeApply.hash} vs ${afterRollback.hash} ⇒ ${beforeApply.hash === afterRollback.hash ? "一致（逐字段比对通过）" : "**不一致，回滚没还原干净**"}`);
  }

  const duplicates = await tool("catalog_duplicates_read", { libraryId });
  console.log(`\n疑似同作：墙上 ${duplicates.cards} 张、进组 ${duplicates.groupedCards} 张、${duplicates.groups} 组（readOnly=${duplicates.readOnly} autoMerge=${duplicates.autoMerge}）`);

  // 4) MCP 拿不到批准权：没有这个工具，也没有那把密钥。
  const noApprove = await rpc("tools/call", { name: "catalog_approve", arguments: { libraryId } });
  console.log(`\nMCP 调 "catalog_approve" → JSON-RPC ${(noApprove.error?.code ?? "?")} ${(noApprove.error?.message ?? "").slice(0, 40)}（工具表里不存在）`);
  const wrongSecret = await http("POST", `/api/admin/media-libraries/${libraryId}/approval`, { approvedBy: "e2e" }, false);
  console.log(`MCP 那条链路用的 admin token 想直接批准 → ${wrongSecret.status} ${wrongSecret.body?.code}（长期 token 不给签发权）`);
  console.log(`扫描快照报的文件数：${scan.files}`);
} finally {
  console.log("\n每个工具的实际落点：");
  for (const [name, status, detail] of results) console.log(`  ${name.padEnd(24)} ${status.padEnd(6)} ${detail}`);
  mcp.stdin.end();
  mcp.kill();
  await backend.close();
}
console.log(`\n临时副本：${work}`);
