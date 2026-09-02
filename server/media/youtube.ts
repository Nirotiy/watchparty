import { youtube, type youtube_v3 } from "@googleapis/youtube";
import config from "../config.ts";

let disabledLogged = false;
let client: youtube_v3.Youtube | null = null;

function api(): youtube_v3.Youtube | null {
  if (!config.youtubeApiKey) {
    if (!disabledLogged) {
      disabledLogged = true;
      console.log("youtube search disabled (no YOUTUBE_API_KEY)");
    }
    return null;
  }
  if (!client) {
    client = youtube({
      version: "v3",
      auth: config.youtubeApiKey,
    });
  }
  return client;
}

function mapSearchResult(video: youtube_v3.Schema$SearchResult): PlaylistVideo {
  return {
    channel: video.snippet?.channelTitle ?? "",
    url: "https://www.youtube.com/watch?v=" + (video.id?.videoId ?? ""),
    name: video.snippet?.title ?? "",
    img: video.snippet?.thumbnails?.default?.url ?? "",
    duration: 0,
    type: "youtube",
  };
}

function mapPlaylistItem(item: youtube_v3.Schema$PlaylistItem): PlaylistVideo {
  return {
    url:
      "https://www.youtube.com/watch?v=" +
      (item.snippet?.resourceId?.videoId ?? ""),
    name: item.snippet?.title ?? "",
    img: item.snippet?.thumbnails?.default?.url ?? "",
    channel: item.snippet?.channelTitle ?? "",
    duration: 0,
    type: "youtube",
  };
}

/** Returns [] when the API key is missing. */
export async function searchYoutube(query: string): Promise<PlaylistVideo[]> {
  const yt = api();
  if (!yt) {
    return [];
  }
  const response = await yt.search.list({
    part: ["snippet"],
    type: ["video"],
    maxResults: 25,
    q: query,
  });
  return response.data.items?.map(mapSearchResult) ?? [];
}

export async function youtubePlaylist(
  playlistId: string,
): Promise<PlaylistVideo[]> {
  const yt = api();
  if (!yt) {
    return [];
  }
  const response = await yt.playlistItems.list({
    part: ["snippet"],
    playlistId,
    maxResults: 100,
  });
  return response.data.items?.map(mapPlaylistItem) ?? [];
}
