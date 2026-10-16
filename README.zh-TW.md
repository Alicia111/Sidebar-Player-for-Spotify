# Sidebar Player for Spotify

[English](README.md) | 繁體中文

不用離開編輯器，直接在 VS Code 裡控制 Spotify：

- **Now Playing** 側邊欄：專輯封面、可拖曳的進度條、播放／暫停、上一首／下一首、隨機播放、重複播放、音量、按讚，還能切換播放裝置
- **搜尋**歌曲、專輯、藝人和播放清單，結果可以直接播放、加入佇列、按讚或加進播放清單。點歌曲上的藝人名稱，可以看他的專輯和單曲。
- **Queue（佇列）**：顯示目前從哪裡播放（播放清單、專輯、藝人或「已按讚的歌曲」）、正在播的歌，以及接下來要播什麼。點一下後面的歌就會直接跳過去。
- **Playlists（播放清單）**：最近播放（最近 50 次播放，同一首只列一次）、已按讚的歌曲，以及你的播放清單。點歌曲會在原本的清單脈絡中播放；右鍵選單可以加入佇列、按讚／取消讚、加到其他播放清單，或從目前所在的播放清單移除。
- **Devices（裝置）**：列出你的 Spotify Connect 裝置，可以把播放轉移到其他裝置
- **狀態列**控制鈕和**快捷鍵**
- 正在播放的歌、搜尋結果、藝人和專輯都有 **Listen on Spotify** 連結，可以直接在 Spotify 開啟
- **歌詞**面板會開在編輯器旁邊，歌詞來自 [LRCLIB](https://lrclib.net)。有時間軸的歌詞會標出目前唱到的那一行並跟著捲動，點某一行就會跳到那個時間點。

> **VS Code 本身不會發出聲音。** VS Code 的 webview 沒有 Spotify 需要的 DRM 模組，所以這個 extension 是一個遙控器，用來控制你已經開著的 Spotify（桌面版、網頁版 open.spotify.com、手機、音響……）。
>
> 按下播放時如果沒有裝置在線上，extension 會幫你挑一個：優先用目前作用中的裝置，其次是上次用過的，再來是唯一可用的那一台。如果一台都沒有，就會自動找到並開啟 Spotify 桌面版（有設定 `spotifySidebar.desktopCommand` 的話就執行它），等它準備好就在上面播放。

## 需求

- **Spotify Premium** 帳號。Spotify Web API 只開放 Premium 帳號控制播放；而且從 2026 年 2 月起，Development Mode app 的擁有者也必須是 Premium。
- 一個你自己的 Spotify app（免費，兩分鐘就能建好）：
  1. 打開 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)，點 **Create app**。
  2. 加入 Redirect URI `http://127.0.0.1:8888/callback`。Spotify 不接受 `localhost`，請用 IP 的寫法。
  3. 勾選 **Web API**，儲存後複製 **Client ID**。
  4. 如果要讓別人用你的 Client ID，請到 **User Management** 加入對方的 Spotify 帳號。Development Mode 的 app 只有名單上的使用者能用。

## 開始使用

1. 點 Activity Bar 上的 Spotify 圖示，再點 **Log in to Spotify**。
2. 依提示貼上 Client ID，它會存進 `spotifySidebar.clientId` 設定。
3. 在瀏覽器開啟的分頁中同意授權，然後回到 VS Code。

登入使用 OAuth Authorization Code with PKCE，不需要 client secret。Refresh token 存放在 VS Code 加密的 SecretStorage 裡。

> 更新版本後如果某個功能顯示需要重新登入（例如「最近播放」），代表新功能需要額外的權限，登出再登入一次就好。

## 指令與快捷鍵

| 指令 | 預設快捷鍵 |
| --- | --- |
| Spotify: Play / Pause | `Ctrl+Alt+P` |
| Spotify: Next Track | `Ctrl+Alt+.` |
| Spotify: Previous Track | `Ctrl+Alt+,` |
| Spotify: Like / Unlike Current Track | `Ctrl+Alt+L` |
| Spotify: Search | 無 |
| Spotify: Show Lyrics | 無 |
| Spotify: Select Playback Device | 無 |
| Spotify: Add Current Track to Playlist | 無 |
| Spotify: Create Playlist | 無 |
| Spotify: Toggle Shuffle / Cycle Repeat Mode | 無 |

有些桌面環境把 `Ctrl+Alt+L` 用來鎖定螢幕，衝突的話可以到 **Keyboard Shortcuts** 改掉。

## 設定

| 設定 | 預設值 | 說明 |
| --- | --- | --- |
| `spotifySidebar.clientId` | `""` | 你的 Spotify app 的 Client ID |
| `spotifySidebar.redirectPort` | `8888` | 登入 callback 用的 port，必須和你註冊的 Redirect URI 一致 |
| `spotifySidebar.lyrics.enabled` | `true` | 從 lrclib.net 抓歌詞。開啟時，正在播放的歌名、藝人、專輯和長度會傳送到 lrclib.net |
| `spotifySidebar.autoLaunchDesktop` | `true` | 沒有裝置在線上時，自動開啟 Spotify 桌面版 |
| `spotifySidebar.minimizeDesktop` | `true` | 由 extension 開啟的桌面版會自動最小化（Linux：需要 X11/XWayland 和 `python3`，不用裝額外套件；Windows：`--minimized`；macOS：在背景開啟） |
| `spotifySidebar.desktopCommand` | *（空白）* | 要執行的程式（直接執行、不經過 shell，只能在使用者設定中設定）。空白代表自動偵測：Linux 找 `PATH`、Snap 和 Flatpak；macOS 找 `/Applications` 和 `~/Applications`；Windows 找 spotify.com 安裝版和 Microsoft Store 版 |
| `spotifySidebar.pollIntervalMs` | `3000` | Now Playing 顯示時更新播放狀態的間隔（毫秒）。只剩狀態列時會慢 5 倍，VS Code 不在前景時完全不更新 |

## 已知限制（Spotify API 規則）

- Spotify Web API 沒有歌詞 endpoint，所以歌詞來自社群維護的 LRCLIB 資料庫。比較冷門的歌可能沒有歌詞，或只有沒對時間軸的版本。
- Spotify 只會列出你**擁有或共同編輯**的播放清單裡的歌曲。追蹤的播放清單還是可以用播放鈕播放。
- 搜尋每頁最多 10 筆，用 **Load more** 載入下一頁。
- 播放清單在樹狀列表中最多顯示前 500 首。
- 從播放清單移除歌曲時，同一首歌的所有副本都會一起移除，因為 Spotify API 無法指定單一位置。
- 部分裝置（例如某些智慧音響）會被 Spotify 標記為 *restricted*，無法透過 API 控制。

## 開發

```bash
npm install
npm run build        # 打包 extension 和 webview 到 dist/
npm run watch        # 檔案變更時自動重新打包
npm run typecheck
npm test             # node:test 單元測試
npm run package      # typecheck + test + production build + .vsix
```

在 VS Code 按 **F5** 開啟 Extension Development Host。Log 在 **Output → Spotify** 頻道。

專案結構：

```
src/
  auth/       PKCE、OAuth token 請求、loopback callback server、session 儲存
  api/        HTTP client（401 自動 refresh、429 退避重試）和有型別的 endpoint 封裝
  state/      播放狀態輪詢和純函式的 view-model 轉換
  shared/     extension <-> webview 訊息協定（收到時會驗證）
  views/      Now Playing webview 主機、播放清單／裝置樹狀列表、狀態列
  webview/    瀏覽器端 UI（純 DOM，沒有用框架）
```

## 授權

MIT，詳見 [LICENSE](LICENSE)。Webview 圖示使用 Google 的 Material Icons，採 Apache License 2.0 授權，詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本專案為獨立專案，與 Spotify 沒有任何關聯，也未獲得 Spotify 背書。Spotify 是 Spotify AB 的商標。
