# Sidebar Player for Spotify

Control Spotify without leaving the editor:

- **Now Playing** sidebar view: cover art, seekable progress bar, play/pause, next/previous, shuffle, repeat, volume, like button and device switcher
- **Search** songs, albums, artists and playlists, then play, queue, like or add results to a playlist
- **Queue** tree: where playback comes from (playlist, album, artist or Liked Songs), the current track and what plays next. Click an upcoming track to jump to it.
- **Playlists** tree: Liked Songs and your playlists. Click a track to play it in context. The context menu adds to queue, likes/unlikes or adds to another playlist.
- **Devices** tree: see your Spotify Connect devices and move playback between them
- **Status bar** controls and keyboard shortcuts
- **Listen on Spotify** links on the playing track, search results, artists and albums open the item in Spotify
- **Lyrics** panel beside the editor, from [LRCLIB](https://lrclib.net). Time-synced lyrics highlight the current line and follow playback, and clicking a line seeks to it.

> **Audio does not play inside VS Code.** VS Code webviews lack the DRM module Spotify requires, so this extension is a remote control for a Spotify app you already have open (desktop, web player at open.spotify.com, phone, speaker…).
>
> If nothing is online when you press play, the extension picks a device for you: the active one, else the one you used last, else the only one available. With no device at all it finds and starts the Spotify desktop app (or runs `spotifySidebar.desktopCommand` if you set one) and plays there once it is ready.

## Requirements

- A **Spotify Premium** account. Spotify's Web API only allows playback control for Premium, and since February 2026 the owner of a Development Mode app must have Premium too.
- Your own Spotify app (free, takes two minutes):
  1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and **Create app**.
  2. Add the Redirect URI `http://127.0.0.1:8888/callback`. Spotify does not accept `localhost`, so use the IP form.
  3. Tick **Web API**, save, and copy the **Client ID**.
  4. If someone else will use your Client ID, add their Spotify account under **User Management**. Development Mode apps only work for listed users.

## Getting started

1. Open the Spotify icon in the Activity Bar and click **Log in to Spotify**.
2. Paste your Client ID when asked. It is saved to the `spotifySidebar.clientId` setting.
3. Approve access in the browser tab that opens, then return to VS Code.

Login uses OAuth Authorization Code with PKCE, so there is no client secret. The refresh token is kept in VS Code's encrypted SecretStorage.

## Commands & shortcuts

| Command | Default key |
| --- | --- |
| Spotify: Play / Pause | `Ctrl+Alt+P` |
| Spotify: Next Track | `Ctrl+Alt+.` |
| Spotify: Previous Track | `Ctrl+Alt+,` |
| Spotify: Like / Unlike Current Track | `Ctrl+Alt+L` |
| Spotify: Search | none |
| Spotify: Show Lyrics | none |
| Spotify: Select Playback Device | none |
| Spotify: Add Current Track to Playlist | none |
| Spotify: Create Playlist | none |
| Spotify: Toggle Shuffle / Cycle Repeat Mode | none |

Some desktops already use `Ctrl+Alt+L` to lock the screen. Rebind it under **Keyboard Shortcuts** if it clashes.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `spotifySidebar.clientId` | `""` | Client ID of your Spotify app |
| `spotifySidebar.redirectPort` | `8888` | Login callback port. It must match the Redirect URI you registered. |
| `spotifySidebar.lyrics.enabled` | `true` | Fetch lyrics from lrclib.net. The playing song's title, artist, album and length are sent there. |
| `spotifySidebar.autoLaunchDesktop` | `true` | Start the Spotify desktop app when no device is online |
| `spotifySidebar.minimizeDesktop` | `true` | Minimize the desktop app when the extension starts it (Linux: X11/XWayland + `python3`, no extra packages; Windows: `--minimized`; macOS: opens in the background) |
| `spotifySidebar.desktopCommand` | *(empty)* | Executable to start (run directly, no shell; user settings only). Empty means auto-detect: `PATH`, Snap and Flatpak on Linux, `/Applications` and `~/Applications` on macOS, the spotify.com installer and Microsoft Store app on Windows |
| `spotifySidebar.pollIntervalMs` | `3000` | Playback refresh interval while Now Playing is visible. The status bar alone polls 5× slower, and nothing polls while VS Code is unfocused. |

## Known limitations (Spotify API rules)

- Spotify's Web API has no lyrics endpoint, so lyrics come from the community-run LRCLIB database. Less common songs may have no lyrics or only unsynced ones.

- Spotify only lists the tracks of playlists you **own or collaborate on**. Followed playlists can still be played with the play button.
- Search returns at most 10 results per page. Use **Load more** for the next page.
- The tree shows the first 500 tracks of a playlist.
- Some devices, such as certain smart speakers, are marked *restricted* by Spotify and cannot be controlled through the API.

## Development

```bash
npm install
npm run build        # bundle extension + webview into dist/
npm run watch        # rebuild on change
npm run typecheck
npm test             # node:test unit tests
npm run package      # typecheck + test + production build + .vsix
```

Press **F5** in VS Code to launch an Extension Development Host. Logs are in the **Output → Spotify** channel.

Layout:

```
src/
  auth/       PKCE, OAuth token requests, loopback callback server, session storage
  api/        HTTP client (401 refresh, 429 back-off) and typed endpoint wrappers
  state/      playback polling and pure view-model mappers
  shared/     extension <-> webview message protocol (validated on receipt)
  views/      Now Playing webview host, playlist/device trees, status bar
  webview/    browser-side UI (plain DOM, no framework)
```

## License

MIT, see [LICENSE](LICENSE). The webview icons are Google's Material Icons under the Apache License 2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This is an independent project, not affiliated with or endorsed by Spotify. Spotify is a trademark of Spotify AB.
