import { spawn } from 'node:child_process';
import { mkdtemp, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const maxSeconds = Number(process.env.MAX_TRACK_SECONDS || 3600);
const maxBytes = Number(process.env.MAX_ATTACHMENT_MB || 25) * 1024 * 1024;
export const ytArgs = () => ['--ignore-config', '--no-playlist', '--no-warnings', '--js-runtimes', 'node',
  '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2',
  ...(process.env.YTDLP_COOKIES_FILE ? ['--cookies', process.env.YTDLP_COOKIES_FILE] : [])];

export function runJson(args, timeout = 45000, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', [...ytArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', failed = false;
    const cancel = () => { failed = true; child.kill('SIGKILL'); clearTimeout(timer); reject(new Error('再生操作がキャンセルされました')); };
    if (signal) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) queueMicrotask(cancel); }
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); reject(new Error('YouTube検索がタイムアウトしました')); }, timeout);
    child.stdout.on('data', b => {
      out += b.toString(); if (out.length > 8 * 1024 * 1024) { failed = true; child.kill(); reject(new Error('検索結果が大きすぎます')); }
    });
    child.stderr.on('data', b => { err = (err + b.toString()).slice(-4000); });
    child.on('error', () => { clearTimeout(timer); failed = true; reject(new Error('yt-dlpがありません。Dockerfileでデプロイしてください')); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (failed) return;
      if (code !== 0) {
        console.warn('YouTube metadata failed:', err.replace(/https?:\/\/\S+/g, '[URL]'));
        reject(new Error('YouTube取得に失敗しました。動画の公開状態・地域制限・YouTube側のBot制限を確認してください')); return;
      }
      try { resolve(JSON.parse(out)); } catch { reject(new Error('YouTube検索結果を読み取れません')); }
    });
  });
}
export function parseInput(input) {
  input = input.trim().replace(/^<(.+)>$/, '$1');
  if (!input) throw new Error('曲名、YouTube／Spotifyリンク、または音声ファイルを指定してください');
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('通常のHTTPSリンクを指定してください');
    const host = url.hostname.toLowerCase();
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host)) {
      const id = host.endsWith('youtu.be') ? url.pathname.slice(1).split('/')[0]
        : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1];
      if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('YouTubeの動画リンクを指定してください。プレイリスト単体は未対応です');
      return { type: 'youtube', value: `https://www.youtube.com/watch?v=${id}` };
    }
    if (host === 'open.spotify.com') {
      const match = url.pathname.match(/^\/(?:intl-[a-z]+\/)?(track|album|playlist)\/([A-Za-z0-9]{22})\/?$/);
      if (!match) throw new Error('Spotifyの曲・アルバム・プレイリストの正式リンクを指定してください');
      return { type: 'spotify', kind: match[1], id: match[2], value: `https://open.spotify.com/${match[1]}/${match[2]}` };
    }
    throw new Error('リンクはYouTubeまたはSpotifyに対応しています。音声はDiscordにファイル添付してください');
  }
  return { type: 'search', value: input.slice(0, 300) };
}

let spotifyToken;
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`外部サービスがHTTP ${response.status}を返しました`);
  return response.json();
}
async function spotifyApi(endpoint) {
  if (!spotifyToken || spotifyToken.expires < Date.now()) {
    const token = await jsonFetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
    });
    spotifyToken = { value: token.access_token, expires: Date.now() + (token.expires_in - 60) * 1000 };
  }
  return jsonFetch(`https://api.spotify.com/v1/${endpoint}`, { headers: { Authorization: `Bearer ${spotifyToken.value}` } });
}
export async function spotifyQueries(input) {
  const keys = process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET;
  if (!keys) {
    if (input.kind !== 'track') throw new Error('Spotifyアルバム／プレイリストはRailwayにSPOTIFY_CLIENT_IDとSPOTIFY_CLIENT_SECRETの設定が必要です');
    const data = await jsonFetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(input.value)}`);
    if (!data.title) throw new Error('Spotify曲名を取得できません。Spotifyキーを設定するか曲名で検索してください');
    return [{ query: `${data.title} audio`, spotify: input.value }];
  }
  const market = /^[A-Z]{2}$/.test(process.env.SPOTIFY_MARKET || 'JP') ? process.env.SPOTIFY_MARKET || 'JP' : 'JP';
  let tracks;
  if (input.kind === 'track') tracks = [await spotifyApi(`tracks/${input.id}?market=${market}`)];
  else {
    const endpoint = input.kind === 'album' ? `albums/${input.id}/tracks` : `playlists/${input.id}/items`;
    let page = await spotifyApi(`${endpoint}?limit=50&market=${market}`);
    tracks = page.items.map(x => x.track ?? x.item ?? x).filter(x => x?.name && !x.is_local && x.type !== 'episode');
    // Intentionally bounded: one command imports at most 50 tracks, clearly announced.
  }
  if (!tracks.length) throw new Error('Spotifyに再生可能な曲がありません。非公開リストやAPIのアクセス制限も確認してください');
  return tracks.map(t => ({ query: `${t.name} ${t.artists?.map(a => a.name).join(' ') || ''} audio`,
    spotify: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : input.value) }));
}
export async function youtubeTrack(value, signal) {
  let info = await runJson(['--dump-single-json', '--skip-download', '--', value], 45000, signal);
  if (info.entries) info = info.entries.find(Boolean);
  if (!info?.id || !/^[A-Za-z0-9_-]{11}$/.test(info.id)) throw new Error('曲が見つかりません');
  if (info.is_live || info.live_status === 'is_live') throw new Error('ライブ配信は未対応です');
  if (info.duration > maxSeconds) throw new Error(`動画は${Math.floor(maxSeconds / 60)}分以内にしてください`);
  return { type: 'youtube', title: info.title || info.id, duration: info.duration,
    url: `https://www.youtube.com/watch?v=${info.id}` };
}
export function attachmentTrack(attachment) {
  if (!/\.(mp3|wav|ogg|m4a|aac|flac|opus|mp4|webm)$/i.test(attachment.name || '')) throw new Error('MP3、WAV、OGG、M4A、FLACなどの音声／動画ファイルを添付してください');
  if (attachment.size > maxBytes) throw new Error(`添付ファイルは${Math.floor(maxBytes / 1024 / 1024)}MB以内にしてください`);
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) throw new Error('Discordの添付ファイルを使ってください');
  return { type: 'file', title: attachment.name, url: attachment.url };
}

export async function downloadAttachment(track, signal) {
  const dir = await mkdtemp(path.join(tmpdir(), 'asira-music-'));
  const file = path.join(dir, 'audio');
  try {
    const response = await fetch(track.url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
    if (!response.ok || !response.body) throw new Error('添付ファイルを取得できません。もう一度添付してください');
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('添付ファイルが大きすぎます');
    const handle = await open(file, 'w');
    try {
      let count = 0;
      for await (const chunk of response.body) {
        count += chunk.byteLength;
        if (count > maxBytes) throw new Error('添付ファイルが大きすぎます');
        await handle.write(chunk);
      }
    } finally { await handle.close(); }
    return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (e) { await rm(dir, { recursive: true, force: true }); throw e; }
}
export { maxSeconds };
