import assert from "node:assert/strict"
import { test } from "node:test"
import { breadcrumbPath, childDirectoryPath } from "../src/lib/media-library-navigation.ts"

test("directory navigation sends relative paths instead of opaque media ids", () => {
  assert.equal(childDirectoryPath("/", "Season 01"), "/Season 01")
  assert.equal(childDirectoryPath("/Anime", "Season 01"), "/Anime/Season 01")
})

test("breadcrumbs target each ancestor and the library root", () => {
  const breadcrumbs = ["Anime", "Season 01", "Specials"]
  assert.equal(breadcrumbPath(breadcrumbs, -1), "/")
  assert.equal(breadcrumbPath(breadcrumbs, 0), "/Anime")
  assert.equal(breadcrumbPath(breadcrumbs, 1), "/Anime/Season 01")
  assert.equal(breadcrumbPath(breadcrumbs, 2), "/Anime/Season 01/Specials")
})
