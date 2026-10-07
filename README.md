# Asira AFK + Music Bot v1.1

GitHubに入れてRailwayで動かすDiscord Botです。Node.js 24 / discord.js v14 / DAVE対応 @discordjs/voice。

## 最初に知っておくこと

- セルフミュートの時間は、Botが入っていないVCも監視します。サーバーミュートだけではこの判定になりません。
- **無言時間はBotが参加しているVCだけ**監視します。1つのBotは同じサーバーで同時に1つのVCにしか参加できません。
- **人が入った通常VCへ自動接続**。人（Botを除く）が全員いなくなったら切断。別のVCに人がいればそちらへ移動します。
- 複数VCに人がいる場合は現在のVCを優先。現在のVCが空になるまで、別VCへの参加では移動しません。空になった後の候補はチャンネル一覧順です。
- `/afkch` のAFK移動先、サーバー標準のAFKチャンネル、除外VCには接続しません。音楽リクエストも受け付けません。
- 音楽中に全員いなくなったら曲とキューを終了します。音楽が終わっても人がいる間はそのVCで監視を続けます。
- 画面共有中は両方の判定から常に除外。共有終了・VC移動・監視接続の再開時には猶予時間を最初から計測します。
- 無言はDiscordから届く発話パケットで判定。音声の内容の認識や録音はしません。マイクのノイズでも発話と判断される場合があります。
- Spotifyは曲情報からYouTubeの候補を検索して再生します。Spotify音声そのものは再生しません。同名の別バージョンになる場合があります。
- Discordの音声受信は公式に安定動作が保証されていません。YouTubeもホスティング環境によってBot制限があります。

## 1. Discord Botを作る

1. https://discord.com/developers/applications を開いて **New Application**。
2. **Bot** → トークンを取得。トークンはGitHubやDiscordに貼らないでください。
3. Botページの **MESSAGE CONTENT INTENT** をON。これがないと `!p` が動きません。
4. **Installation / OAuth2 URL Generator** で `bot` と `applications.commands` を選択してサーバーへ招待。
5. Botに以下の権限を付ける（各VC・テキストチャンネルの上書き設定も確認）。

| 権限 | 用途 |
|---|---|
| チャンネルを見る | VCとコマンドチャンネルの利用 |
| メッセージを送信・メッセージ履歴を読む | 返答と音楽案内 |
| 接続・発言 | VC監視と音楽再生 |
| メンバーを移動 | AFKの移動 |
| ボイスチャンネルステータスを設定 | 曲名表示 |
| チャンネルの管理 | 移動／切断後に旧VCの曲名を消す |

Botをサーバー側でスピーカーミュートにすると無言監視できません。通常VC専用で、ステージは対象外です。

## 2. GitHubに入れる

新しいリポジトリを作って、このフォルダの**中身**をアップロード。
リポジトリ直下に `package.json`、`package-lock.json`、`Dockerfile`、`railway.json`、`src` がある形にします。
ZIPをそのままアップロードしないでください。
`.env.example` は見本。`.env`、トークン、cookies.txt、node_modules、data はアップロード不要です。

## 3. Railwayで動かす

1. https://railway.com → New Project → Deploy from GitHub repo → このリポジトリを選ぶ。
2. **Variables** に次を追加。

```env
DISCORD_TOKEN=Discordで取得したBotトークン
DATA_DIR=/data
PREFIX=!
GUILD_ID=自分のDiscordサーバーID
```

`GUILD_ID` は任意です。入れるとそのサーバーへコマンドを登録します。省略すると全サーバー用で、反映に少し時間がかかる場合があります。
サーバーIDはDiscordの開発者モードをONにして、サーバーを右クリック／長押し → IDをコピー。

3. Botサービスに **Volume** を追加して、マウント先を **`/data`** にする。
   **これを付けないと再デプロイでAFK設定や除外登録が消えます。**
4. Dockerfileでビルドされていることを確認。起動コマンドは `npm start`。
5. サービスのレプリカ数は **1**。Serverless / App SleepingはOFF。常時起動のワーカーとして使います。
6. Deploy Logsに `Logged in as ...` と `Commands registered` が出れば起動完了。

公開ドメインやHTTPポートは不要です。稼働にはRailwayの利用料金・利用枠が必要です。

## 4. AFKを設定

DiscordでまずAFK移動先を設定します。`channel` はコマンドの候補からVCを選びます。

```text
/afkch channel:AFK用VC
```

これだけでセルフミュート・無言の両方の移動先を設定して、AFK移動と自動接続をONにします。
監視VCを指定する必要はありません。既に人がいるVCにも自動で接続します。
初期値はセルフミュート5分・無言10分。時間変更は次のコマンドです。

```text
/afk mute seconds:300
/afk silence seconds:600
```

画面共有中は移動しません。チェックは5秒ごとなので設定時間から数秒遅れる場合があります。
セルフミュートは入室時から、無言はBotが同じVCで受信を始めてから計測します。
ミュート解除・発話でそれぞれのタイマーをリセットします。
両方の移動先VCは再移動しない安全地帯になります。

| コマンド | 用途 |
|---|---|
| `/afk mute seconds:300 target:VC` | セルフミュートの時間・移動先を変更 |
| `/afk silence seconds:600 target:VC` | 無言の時間・移動先を変更 |
| `/afkch channel:VC` | ミュート・無言の共通移動先を設定して自動監視ON |
| `/afk exempt user:人` | この人はミュート／無言でも移動しない |
| `/afk exempt user:人 kind:mute` | セルフミュート判定だけ除外。無言判定は残る |
| `/afk unexempt user:人` | 除外解除 |
| `/afk exemptrole role:ロール` | ロール全員を除外 |
| `/afk unexemptrole role:ロール` | ロール除外解除 |
| `/afk ignore channel:VC` | VC全体を除外 |
| `/afk unignore channel:VC` | VCの除外解除 |
| `/afk log channel:テキストch` | 移動・失敗ログの送信先 |
| `/afk log` | ログ送信を解除 |
| `/afk off` / `/afk on` | AFK移動全体をOFF／ON |
| `/afk status` | 設定・Bot参加VC・除外を確認 |

時間は**秒**。`seconds:0` で該当の判定を無効にできます。
AFKの管理は「サーバー管理」権限がある人だけ。音楽コマンドは一般メンバーも利用できます。
`exempt` の初期値は両方です。ミュートだけ除外すると無言側で移動する可能性があるため、通常は省略がおすすめ。
設定を変えた直後はタイマーをリセットして猶予時間を確保します。
古いバージョンの `watchChannel` 設定は使いません。`/afk watch` は廃止して自動選択になりました。
Botが停止していた時間は数えません。再起動で時間計測は最初から始まります。

## 5. 音楽を使う

VCへ参加して、Botが見られるテキストチャンネルで送信。

```text
!p 曲名
!play 曲名 アーティスト名
!p https://www.youtube.com/watch?v=動画ID
!p https://open.spotify.com/track/曲ID
```

ファイルの場合は **MP3などを添付して、本文に `!p`** と書いて送信。
コマンドを送った人のVCに参加して再生します。再生中の追加リクエストはキューへ入ります。
別VCで再生中の場合は、そのVCに参加するか再生終了後にリクエストしてください。
VCのステータスは **「曲名 を再生中」** に更新。終了後は消します（元のステータスは復元しません）。

| コマンド | 用途 |
|---|---|
| `!skip` / `!s` | 次の曲 |
| `!queue` / `!q` | キュー一覧 |
| `!np` / `!nowplaying` | 再生中の曲 |
| `!pause` / `!resume` | 一時停止／再開 |
| `!volume 50` | 音量0〜100。初期値50 |
| `!clear` | 待機中の曲をすべて削除 |
| `!shuffle` | 待機キューをシャッフル |
| `!stop` / `!leave` | 再生・キューを終了。人がいれば監視継続、無人なら切断 |
| `!help` / `/help` | コマンド一覧 |

再生操作はBotと同じVCにいる人だけ。キューと再生状況は他のVCからも確認できます。Bot以外の人が全員抜けたら自動終了します。
添付は初期25MB以内、1曲60分以内。YouTubeプレイリスト単体・ライブ配信は未対応です。
音楽キューは再起動で消えます。AFK設定・除外はVolumeに保存します。

## Spotifyについて

公開の曲リンクはSpotifyのoEmbedからタイトルを取得します。キーなしの検索はアーティスト情報が足りず、別曲が選ばれる場合があります。
より正確な曲名・アーティスト取得やアルバム／プレイリストを使う場合は、Spotifyの開発者アプリを作り、Railway Variablesに追加します。

```env
SPOTIFY_CLIENT_ID=SpotifyアプリのClient ID
SPOTIFY_CLIENT_SECRET=SpotifyアプリのClient Secret
SPOTIFY_MARKET=JP
```

Spotify APIの利用資格・Development Modeの制限などで403になる場合があります。
非公開リストは未対応。アルバム／プレイリストは1コマンドにつき先頭50曲まで。
URL短縮の `spotify.link` ではなく `open.spotify.com` の正式URLを使用してください。

## よくある問題

- **`!p` に反応しない**：MESSAGE CONTENT INTENT、チャンネル閲覧／送信権限、起動ログを確認。
- **スラッシュコマンドがない**：`applications.commands` 付きで招待。GUILD_IDが正しいか確認。
- **無言の人が移動しない**：Botが同じVCに参加中か、スピーカーミュートになっていないか `/afk status` で確認。
- **AFK移動できない**：移動元・移動先の権限と人数制限を確認。失敗時は1分空けて再試行。
- **曲名ステータスが出ない**：「ボイスチャンネルステータスを設定」権限。旧VCの消去には「チャンネルの管理」も必要。
- **YouTube取得失敗**：RailwayのIPがYouTubeに制限される場合があります。再ビルドでyt-dlpを更新。それでも失敗する場合は音声ファイルで再生してください。
- **Cookiesを使う場合**：Netscape形式の秘密ファイルをVolumeに保存して `YTDLP_COOKIES_FILE` にパスを設定。GitHubへアップロードしない。Cookiesだけで制限が解消する保証はありません。
- **再起動で設定が消える**：Volumeのマウント先とDATA_DIRが `/data` で一致しているか確認。

## 開発・確認

```bash
npm ci
npm test
npm start
```

ローカル再生にはFFmpeg・Python・`yt-dlp[default]` が必要。Railway用Dockerfileではインストールされます。
GitHub ActionsはAFK判定・設定永続化・入力解析・再生制御・自動VC選択・/afkchをチェックします。
この配布時には実際のDiscord BotトークンやRailwayアカウントを使った実機テストは行っていません。

参照：
- https://docs.discord.com/developers/resources/channel#set-voice-channel-status
- https://discord.js.org/docs/packages/voice/stable
- https://github.com/yt-dlp/yt-dlp
- https://developer.spotify.com/documentation/web-api/reference/get-track
- https://docs.railway.com/builds/dockerfiles
- https://docs.railway.com/volumes
