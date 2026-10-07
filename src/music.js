import { spawn } from 'node:child_process';
import { forbiddenVoice, humans } from './auto-voice.js';
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, NoSubscriberBehavior } from '@discordjs/voice';
import { parseInput, spotifyQueries, attachmentTrack, youtubeTrack, downloadAttachment, ytArgs, maxSeconds } from './sources.js';

const maxQueue = Number(process.env.MAX_QUEUE || 100);
const safeText = text => String(text).replace(/[@`*_~|]/g, '').slice(0, 180);
export class Music {
  constructor(client, voices) {
    this.client = client; this.voices = voices; this.sessions = new Map();
    voices.musicBusy = id => this.busy(id);
    voices.musicEmpty = (id, channelId) => {
      const s = this.sessions.get(id);
      if (s && s.channelId === channelId) {
        this.stop(s);
        this.say(s, 'VCが無人になったかAFK対象外VCになったため、音楽とキューを終了しました。');
      }
    };
    client.on('voiceStateUpdate', (old, next) => {
      if (next.id !== client.user?.id) return;
      const s = this.sessions.get(next.guild.id);
      if (s?.channelId && old.channelId === s.channelId && next.channelId !== s.channelId && this.busy(next.guild.id)) {
        this.stop(s); this.say(s, 'BotがVCから移動／切断されたため再生を終了しました。');
      }
    });
  }
  session(guild) {
    if (this.sessions.has(guild.id)) return this.sessions.get(guild.id);
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    const s = { guild, player, queue: [], current: null, channelId: null, textChannel: null,
      volume: 0.5, generation: 0, pumping: false, pending: 0, lock: Promise.resolve(), media: null, abort: null };
    this.sessions.set(guild.id, s);
    player.on(AudioPlayerStatus.Idle, () => {
      if (s.current) {
        this.disposeMedia(s); s.current = null;
        this.advance(s);
      }
    });
    player.on('error', e => {
      console.warn('Audio:', e.message);
      this.fail(s, '音声を再生できませんでした。次の曲へ進みます。');
    });
    return s;
  }
  busy(id) {
    const s = this.sessions.get(id);
    return !!s && !!(s.pending || s.pumping || s.current || s.queue.length);
  }
  async say(s, content) {
    try { await s.textChannel?.send({ content: content.slice(0, 1900), allowedMentions: { parse: [] } }); }
    catch (e) { console.warn('Music reply:', e.message); }
  }
  async status(s, title) {
    const id = s.channelId;
    if (!id) return;
    // Preserve request order so a delayed clear cannot overwrite the next song.
    s.statusLock = (s.statusLock || Promise.resolve()).catch(() => {}).then(async () => {
      try {
        await this.client.rest.put(`/channels/${id}/voice-status`, { body: { status: title ? `${safeText(title)} を再生中`.slice(0, 500) : null } });
      } catch (e) {
        this.voices.warn(s.guild.id, `VCステータス更新失敗：${e.message}`);
        if (!s.statusWarned) {
          s.statusWarned = true;
          await this.say(s, 'VCステータスを更新できません。「ボイスチャンネルステータスを設定」権限を付けてください。');
        }
      }
    });
    return s.statusLock;
  }
  async add(message, input) {
    const s = this.session(message.guild);
    s.pending++;
    const epoch = s.generation;
    const work = async () => {
      const vc = message.member.voice.channel;
      if (!vc || vc.type !== 2) throw new Error('先に通常のVCに参加してください');
      if (forbiddenVoice(message.guild, this.voices.settings.get(message.guild.id), vc.id)) throw new Error('AFK用VC・除外VCでは音楽を再生できません');
      if ((s.current || s.queue.length || s.pumping) && s.channelId && s.channelId !== vc.id) throw new Error('別のVCで再生中です。そのVCに参加するか再生終了後に使ってください');
      if (s.queue.length >= maxQueue) throw new Error(`キューは${maxQueue}曲までです`);
      if (epoch !== s.generation) throw new Error('再生操作がキャンセルされました');
      s.textChannel = message.channel;
      let tracks;
      const attachment = message.attachments.first();
      if (attachment) tracks = [attachmentTrack(attachment)];
      else {
        const parsed = parseInput(input);
        if (parsed.type === 'spotify') {
          const queries = await spotifyQueries(parsed);
          tracks = queries.map(q => ({ type: 'search', query: q.query, title: q.query, spotify: q.spotify }));
        } else tracks = [{ type: parsed.type, query: parsed.value, url: parsed.type === 'youtube' ? parsed.value : null, title: parsed.value }];
      }
      if (epoch !== s.generation) throw new Error('再生操作がキャンセルされました。もう一度送信してください');
      if (message.member.voice.channelId !== vc.id) throw new Error('検索中にVCが変わりました。参加中のVCからもう一度送信してください');
      if (s.queue.length + tracks.length > maxQueue) throw new Error(`キューは${maxQueue}曲までです。現在${s.queue.length}曲です`);
      const slot = await this.voices.join(message.guild, vc.id);
      if (epoch !== s.generation) throw new Error('接続中に再生操作がキャンセルされました');
      if (message.member.voice.channelId !== vc.id || !humans(message.guild, vc.id).length || forbiddenVoice(message.guild, this.voices.settings.get(message.guild.id), vc.id)) throw new Error('VCが変わったかAFK用VCに設定されました。もう一度送信してください');
      s.channelId = vc.id;
      slot.connection.subscribe(s.player);
      s.queue.push(...tracks.map(t => ({ ...t, requestedBy: message.author.id })));
      await message.reply({ content: `${tracks.length}曲をキューに追加しました。${tracks.length === 50 ? '一度に取り込む上限は50曲です。' : ''}${tracks[0].spotify ? '\nSpotifyの曲名からYouTubeで検索します。' : ''}`, allowedMentions: { parse: [], repliedUser: false } });
      this.advance(s);
    };
    const result = s.lock.then(work);
    s.lock = result.catch(() => {});
    try { await result; }
    finally {
      s.pending--;
      if (!this.busy(s.guild.id)) this.finish(s);
    }
  }
  advance(s) {
    if (s.pumping || s.current) return;
    s.pumping = true;
    this.pump(s).catch(e => console.error('Music pump:', e.message)).finally(() => {
      s.pumping = false;
      if (!s.current && s.queue.length) this.advance(s);
      else if (!s.current && !s.pending) this.finish(s);
    });
  }
  async pump(s) {
    while (!s.current && s.queue.length) {
      const epoch = s.generation;
      const queued = s.queue.shift();
      s.abort = new AbortController();
      let cleanup = null;
      try {
        let track = queued;
        if (queued.type !== 'file') {
          track = { ...await youtubeTrack(queued.type === 'search' ? `ytsearch1:${queued.query}` : queued.url, s.abort.signal),
            requestedBy: queued.requestedBy, spotify: queued.spotify };
        }
        if (epoch !== s.generation) continue;
        let file;
        if (track.type === 'file') {
          const downloaded = await downloadAttachment(track, s.abort.signal);
          file = downloaded.file; cleanup = downloaded.cleanup;
        }
        if (epoch !== s.generation) { await cleanup?.(); continue; }
        const slot = this.voices.slots.get(s.guild.id);
        if (!slot || slot.channelId !== s.channelId || !this.voices.isMonitored(s.guild.id, s.channelId)) throw new Error('VC接続が切れました。もう一度 !p を送信してください');
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe,crypto',
          '-i', file || 'pipe:0', '-t', String(maxSeconds), '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
        const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let yt = null;
        if (!file) {
          yt = spawn('yt-dlp', [...ytArgs(), '-f', 'bestaudio/best', '-o', '-', '--', track.url], { stdio: ['ignore', 'pipe', 'pipe'] });
          yt.stdout.pipe(ffmpeg.stdin);
        } else ffmpeg.stdin.end();
        const media = { ffmpeg, yt, cleanup, epoch, timer: null, stallTimer: null, lastPacket: Date.now() };
        s.media = media; s.current = track;
        const fail = text => { if (s.media === media && s.generation === epoch) this.fail(s, text); };
        ffmpeg.stdin.on('error', () => {});
        ffmpeg.stdout.on('error', () => fail('音声ストリームが切れました。'));
        ffmpeg.on('error', () => fail('FFmpegを起動できません。Dockerfileでデプロイしてください。'));
        yt?.on('error', () => fail('yt-dlpを起動できません。Dockerfileでデプロイしてください。'));
        ffmpeg.stderr.on('data', () => {});
        yt?.stderr.on('data', () => {});
        yt?.on('close', code => { if (code !== 0) fail('YouTube音声を取得できません。公開状態・YouTube側の制限を確認してください。'); });
        ffmpeg.on('close', code => { if (code !== 0) fail('このファイル／動画の音声を読み取れませんでした。'); });
        media.timer = setTimeout(() => fail('30秒以内に音声が届かなかったため次の曲へ進みます。'), 30000);
        ffmpeg.stdout.on('data', () => { media.lastPacket = Date.now(); clearTimeout(media.timer); });
        media.stallTimer = setInterval(() => {
          if ([AudioPlayerStatus.Paused, AudioPlayerStatus.AutoPaused].includes(s.player.state.status)) { media.lastPacket = Date.now(); return; }
          if (Date.now() - media.lastPacket > 45000) fail('音声の受信が止まったため次の曲へ進みます。');
        }, 5000);
        const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
        resource.volume.setVolume(s.volume);
        s.resource = resource; s.player.play(resource);
        await this.status(s, track.title);
        if (s.media === media) await this.say(s, `🎵 **${safeText(track.title)}** を再生中${track.spotify ? `\nSpotify: ${track.spotify}\nYouTube: ${track.url}` : ''}`);
        return;
      } catch (e) {
        await cleanup?.();
        if (epoch === s.generation) await this.say(s, `再生できません：${safeText(e.message)}`);
      }
    }
  }
  disposeMedia(s) {
    const media = s.media; s.media = null; s.resource = null;
    if (!media) return;
    clearTimeout(media.timer); clearInterval(media.stallTimer);
    media.yt?.kill('SIGKILL'); media.ffmpeg?.kill('SIGKILL');
    media.cleanup?.().catch(e => console.warn('Temp cleanup:', e.message));
  }
  fail(s, text) {
    if (!s.current) return;
    this.say(s, text);
    this.skip(s);
  }
  skip(s) {
    s.generation++; s.abort?.abort(); this.disposeMedia(s);
    s.current = null; s.player.stop(true); this.status(s, null);
    this.advance(s);
  }
  stop(s) {
    s.queue.length = 0; s.generation++; s.abort?.abort();
    this.disposeMedia(s); s.current = null; s.player.stop(true); this.status(s, null);
    if (!s.pumping && !s.pending) this.finish(s);
  }
  finish(s) {
    if (this.busy(s.guild.id)) return;
    this.status(s, null); s.channelId = null;
    this.voices.restoreWatch(s.guild).catch(e => this.voices.warn(s.guild.id, e.message));
  }
  async handle(message, command, args) {
    if (['p', 'play'].includes(command)) return this.add(message, args);
    const s = this.sessions.get(message.guild.id);
    if (command === 'queue' || command === 'q') {
      const text = s ? [`再生中：${safeText(s.current?.title || (s.pumping ? '読込中' : 'なし'))}`,
        ...s.queue.slice(0, 15).map((t, i) => `${i + 1}. ${safeText(t.title)}`),
        ...(s.queue.length > 15 ? [`ほか ${s.queue.length - 15}曲`] : [])].join('\n') : 'キューは空です';
      return message.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } });
    }
    if (command === 'np' || command === 'nowplaying') return message.reply({ content: s?.current ? `${safeText(s.current.title)} を再生中` : '再生していません', allowedMentions: { parse: [] } });
    if (!s || !this.busy(s.guild.id)) throw new Error('再生していません');
    if (!message.member.voice.channelId || message.member.voice.channelId !== s.channelId) throw new Error('Botと同じVCで操作してください');
    let reply;
    switch (command) {
      case 'skip': case 's': this.skip(s); reply = 'スキップしました'; break;
      case 'stop': case 'leave': this.stop(s); reply = '再生とキューを終了しました。人がいるVCを自動監視します。誰もいなければ切断します'; break;
      case 'pause': s.player.pause(true); reply = '一時停止しました'; break;
      case 'resume': s.player.unpause(); reply = '再開しました'; break;
      case 'clear': s.queue.length = 0; reply = '待機キューを削除しました'; break;
      case 'shuffle':
        for (let i = s.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]]; }
        reply = 'キューをシャッフルしました'; break;
      case 'volume': {
        const v = Number(args);
        if (!args.trim() || !Number.isFinite(v) || v < 0 || v > 100) throw new Error('!volume 0〜100 を指定してください');
        s.volume = v / 100; s.resource?.volume?.setVolume(s.volume); reply = `音量：${v}%`; break;
      }
      default: return;
    }
    return message.reply({ content: reply, allowedMentions: { parse: [], repliedUser: false } });
  }
  shutdown() {
    for (const s of this.sessions.values()) {
      s.queue.length = 0; s.generation++; s.abort?.abort(); this.disposeMedia(s); s.current = null; s.player.stop(true);
    }
  }
}
