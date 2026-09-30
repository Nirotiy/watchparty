export interface CatalogExclusions {
  items: Array<{
    relativePath: string;
    reason: string;
    createdAt: string;
    stale: boolean;
  }>;
  excluded: number;
  stale: number;
}

export const exclusionText = {
  review: "草稿已更新，请到审阅页批准应用",
  readFailed: "排除清单读取失败",
  restoreFailed: "撤标失败，请重试",
  markFailed: "标记失败，请重试",
  title: "不入库文件",
  rollback: "撤回应用不会清除排除标记。",
  restore: "撤标后重新分类即可恢复草稿，不需要重扫。",
  pending: "标记只改草稿，正式卡变更需批准应用。",
  empty: "这张卡将被移除，需批准应用。",
  stale: "本次扫描中不存在，路径标记已失效。",
} as const;
