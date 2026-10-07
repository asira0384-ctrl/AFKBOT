import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { resetRecord, updateRecord, dueReason } from './policy.js';

export class Afk {
  constructor(client, settings, voices) {
    this.client = client; this.settings = settings; this.voices = voices;
    this.records = new Map(); this.busy = false;
    client.on('voiceStateUpdate', (old, next) => {
      const key = `${next.guild.id}:${next.id}`;
      if (!next.channelId) { this.records.delete(key); return; }
      this.records.set(key, updateRecord(this.records.get(key), old, next, Date.now()));
    });
    voices.on('coverage', (guildId) => this.resetGuild(guildId));
    voices.on('speech', (guildId, userId) => {
      const r = this.records.get(`${guildId}:${userId}`);
      if (r) r.lastSpeech = Date.now();
    });
    client.on('shardDisconnect', () => this.records.clear());
    client.on('shardResume', () => this.records.clear());
    client.on('shardReady', () => this.records.clear());
  }
  resetGuild(guildId) {
    for (const [key, r] of this.records) if (key.startsWith(`${guildId}:`)) {
      r.lastSpeech = Date.now(); r.muteSince = r.muteSince === null ? null : Date.now();
    }
  }
  start() { this.timer = setInterval(() => this.tick().catch(e => console.error('AFK tick:', e.message)), 5000); }
  stop() { clearInterval(this.timer); }
  async tick() {
    if (this.busy || !this.client.isReady()) return;
    this.busy = true;
    try {
      for (const guild of this.client.guilds.cache.values()) {
        if (!guild.available) continue;
        const config = this.settings.get(guild.id);
        if (!config.enabled) continue;
        this.voices.restoreWatch(guild).catch(e => this.voices.warn(guild.id, e.message));
        const now = Date.now();
        for (const voice of guild.voiceStates.cache.values()) {
          const member = voice.member;
          if (!voice.channelId || !member || member.user.bot) continue;
          const key = `${guild.id}:${member.id}`;
          let record = this.records.get(key);
          if (!record || record.channel !== voice.channelId) {
            record = resetRecord(voice, now); this.records.set(key, record);
          }
          // Refresh screen sharing continuously; no backdated move when sharing ends.
          if (voice.streaming) {
            record.lastSpeech = now; record.muteSince = voice.selfMute ? now : null;
          }
          const monitored = this.voices.isMonitored(guild.id, voice.channelId);
          const speaking = this.voices.isSpeaking(guild.id, member.id);
          if (monitored && speaking) record.lastSpeech = now;
          const reason = dueReason({ config, voice, member, record, now, monitored, speaking });
          if (reason) await this.move(guild, member, record, reason, config);
        }
      }
    } finally { this.busy = false; }
  }
  async move(guild, member, record, reason, config) {
    record.moving = true;
    const sourceId = record.channel;
    try {
      const target = await guild.channels.fetch(reason === 'mute' ? config.muteTarget : config.silenceTarget);
      const me = guild.members.me ?? await guild.members.fetchMe();
      if (!target || target.type !== ChannelType.GuildVoice) throw new Error('移動先VCが削除されたか通常VCではありません');
      const source = member.voice.channel;
      if (!source?.permissionsFor(me)?.has(PermissionFlagsBits.MoveMembers)
          || !target.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers])) {
        throw new Error('移動元／移動先のメンバー移動・接続・閲覧権限を確認してください');
      }
      // Re-evaluate after REST waits: streaming, exemptions and channel may have changed.
      const fresh = this.settings.get(guild.id);
      if ((reason === 'mute' ? fresh.muteTarget : fresh.silenceTarget) !== target.id || member.voice.channelId !== sourceId || dueReason({ config: fresh, voice: member.voice, member, record: { ...record, moving: false },
        now: Date.now(), monitored: this.voices.isMonitored(guild.id, sourceId), speaking: this.voices.isSpeaking(guild.id, member.id) }) !== reason) return;
      await member.voice.setChannel(target, reason === 'mute' ? 'AFK: セルフミュート時間超過' : 'AFK: 無言時間超過');
      await this.log(guild, fresh, `${member.user.tag} を <#${target.id}> に移動：${reason === 'mute' ? 'セルフミュート' : '無言'}時間超過`);
    } catch (e) {
      record.retryAfter = Date.now() + 60000;
      await this.log(guild, config, `AFK移動失敗 (${member.id})：${e.message}`);
    } finally { record.moving = false; }
  }
  async log(guild, config, text) {
    console.log(`[AFK ${guild.id}] ${text}`);
    if (!config.logChannel) return;
    try {
      const ch = await guild.channels.fetch(config.logChannel);
      if (ch?.isTextBased()) await ch.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } });
    } catch (e) { console.warn('AFK log:', e.message); }
  }
}
