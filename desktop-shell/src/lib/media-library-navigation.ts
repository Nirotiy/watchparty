export function childDirectoryPath(currentPath: string, directoryName: string): string {
  const parent = currentPath.replace(/\/+$/, "")
  return `${parent}/${directoryName}` || "/"
}

export function breadcrumbPath(breadcrumbs: readonly string[], index: number): string {
  return index < 0 ? "/" : `/${breadcrumbs.slice(0, index + 1).join("/")}`
}
