/**
 * 媒体路由错误码 → 中文（冻结清单，handoff §2 F4）。只按 code 分支，
 * message 仅在码未知时兜底显示，且码本身不会当句子显示给用户。
 */
const MEDIA_ERROR_TEXT: Record<string, string> = {
  OPENLIST_UNAVAILABLE: "源站暂时不可用，稍后重试",
  SOURCE_UNREACHABLE: "连不上这个源，检查地址或网络后重试",
  SOURCE_AUTH_FAILED: "源站拒绝了凭据，检查用户名与密码",
  SOURCE_NOT_CONFIGURED: "这个源还没配置好",
  LIBRARY_ROOT_NOT_FOUND: "这个库的路径在源站上不存在",
  MEDIA_NOT_FOUND: "文件已经不在了，刷新一下",
  MEDIA_UNSUPPORTED: "这个文件两端都放不了",
  MEDIA_ID_KEY_EPHEMERAL: "媒体 ID 密钥是临时的，服务端配置固定密钥后才能保存源",
  CATALOG_UNAVAILABLE: "标题库还没准备好",
  MATCH_NOT_FOUND: "没有匹配结果",
  ADMIN_FORBIDDEN: "只有本机或管理员能修改媒体源",
  MEDIA_ROUTE_DENIED: "客户端不允许访问这个媒体接口",
  INVALID_REQUEST: "有点字段不合法：检查名称、地址与库路径（路径要以 / 开头）",
  AUTH_REJECTED: "站点鉴权失败，请检查已保存的站点凭据",
  AUTH_REQUIRED: "服务需要站点鉴权",
};

export function mediaErrorText(error: unknown, fallback: string): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (MEDIA_ERROR_TEXT[code]) return MEDIA_ERROR_TEXT[code];
  const message = error instanceof Error ? error.message : "";
  return message && message !== code ? message : fallback;
}
