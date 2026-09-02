# WatchParty

![screenshot](https://github.com/howardchung/watchparty/raw/master/public/screenshot_full.png)

A website for watching videos together.

## Description

- Synchronizes the video being watched with the current room
- Plays, pauses, and seeks are synced to all watchers
- Supports:
  - Video files on the Internet (anything accessible via HTTP)
  - YouTube videos
  - Magnet links (via WebTorrent)
  - .m3u8 streams (HLS)
- Create separate rooms for users on demand
- Text chat with replies and reactions

The self-hosted Node server deliberately has no login, billing, database, virtual
browser, or WebRTC signaling. Rooms live in memory and disappear when the server
restarts.

## Quick Start

- Clone this repo via `git clone git@github.com:howardchung/watchparty.git`
- Install npm dependencies for the project via `npm install`
- Start the server via `npm run dev`
  - Defaults to port 8080, customize with `PORT` env var
  - Set `SSL_KEY_FILE` and `SSL_CRT_FILE` for HTTPS.
- Start the React application in a separate shell and port via `npm run ui`
  - Point to server using `VITE_SERVER_HOST` env var if you customized it above
- Duplicate the `.env.example` file
- Rename it to `.env`
- Add a YouTube API key only if you want server-side search

## Advanced Setup (optional)

All of these are optional and the application should work without them. Some functionality may be missing.

### YouTube API (video search)

This project uses the YouTube API for video search, which requires an API key. You can get one from Google [here](https://console.developers.google.com).

Without an API key you won't be able to search for videos via the searchbox.

After creating a **YouTube Data API V3** access, you can create an API key which you can add to your environment variables by copying the `.env.example`, renaming it to `.env` and adding the key to the YOUTUBE_API_KEY variable.

After that restart your server to enable the YouTube API access on your server.

## Tech

- React
- TypeScript
- Node.js
- Express
- Socket.io
