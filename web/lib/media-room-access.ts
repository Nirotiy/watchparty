/** Use the identity stored by the current room's access flow. */
export function mediaRoomHeaders(): Record<string, string> {
  const match = typeof window !== "undefined" ? window.location.pathname.match(/^\/room\/([^/]+)\/?$/) : null;
  const roomId = match ? decodeURIComponent(match[1]) : undefined;
  const token = roomId ? localStorage.getItem(`token_${roomId}`) : null;
  if (!roomId || !token) {
    throw Object.assign(new Error("请先加入房间再浏览媒体库"), { code: "ROOM_ACCESS_REQUIRED" });
  }
  return { "X-WatchParty-Room": roomId, "X-WatchParty-Token": token };
}
