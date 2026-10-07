import { EventEmitter } from 'node:events';
import { chooseVoice, humans, forbiddenVoice } from './auto-voice.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';

export class Voices extends EventEmitter {
  constructor(client, settings) {
    super(); this.client = client; this.settings = settings;
    this.slots = new Map(); this.joining = new Map(); this.warned = new Map();
    this.musicBusy = () => false;
    this.musicEmpty = () => {};
    this.scheduled = new Map();
    client.on('voiceStateUpdate', (old, next) => {
      if (old.channelId !== next.channelId) this.schedule(next.guild);
    });
    client.on('channelDelete', channel => { if (channel.guild) this.schedule(channel.guild); });
    client.on('guildCreate', guild => this.schedule(guild));
  }
  warn(id, message) {
    const key = `${id}:${message}`;
    if ((this.warned.get(key) ?? 0) + 60000 < Date.now()) {
      console.warn(`[Voice ${id}] ${message}`); this.warned.set(key, Date.now());
    }
  }
  isMonitored(id, channel) {
    const s = this.slots.get(id);
    const botVoice = this.client.guilds.cache.get(id)?.members.me?.voice;
    return !!s && s.channelId === channel && s.connection.state.status === VoiceConnectionStatus.Ready
      && !botVoice?.serverDeaf && !botVoice?.selfDeaf;
  }
  isSpeaking(id, userId) { return this.slots.get(id)?.connection.receiver.speaking.users.has(userId) ?? false; }
  async join(guild, channelId) {
    if (this.joining.has(guild.id)) {
      await this.joining.get(guild.id);
      if (this.slots.get(guild.id)?.channelId === channelId) return this.slots.get(guild.id);
    }
    const job = this.doJoin(guild, channelId);
    this.joining.set(guild.id, job);
    try { return await job; } finally { if (this.joining.get(guild.id) === job) this.joining.delete(guild.id); }
  }
  async doJoin(guild, channelId) {
    const channel = await guild.channels.fetch(channelId);
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('通常のボイスチャンネルを指定してください');
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new Error('BotにVCの閲覧・接続・発言権限がありません');
    }
    const prev = this.slots.get(guild.id);
    if (prev?.channelId === channelId && prev.connection.state.status === VoiceConnectionStatus.Ready) return prev;
    if (prev) this.destroy(guild.id);
    const connection = joinVoiceChannel({ guildId: guild.id, channelId, adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: false });
    const slot = { channelId, connection };
    this.slots.set(guild.id, slot); this.emit('coverage', guild.id);
    // Only timing signals are used. Voice audio is never recorded or written to disk.
    connection.receiver.speaking.on('start', user => this.emit('speech', guild.id, user));
    connection.receiver.speaking.on('end', user => this.emit('speech', guild.id, user));
    connection.on('error', e => this.warn(guild.id, e.message));
    connection.on('stateChange', (old, next) => {
      if (old.status !== next.status) this.emit('coverage', guild.id);
      if (next.status === VoiceConnectionStatus.Disconnected) {
        Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]).catch(() => { if (this.slots.get(guild.id) === slot) this.destroy(guild.id); });
      }
    });
    try { await entersState(connection, VoiceConnectionStatus.Ready, 25000); }
    catch (e) { if (this.slots.get(guild.id) === slot) this.destroy(guild.id); throw new Error('VCに接続できません。接続権限やRailwayログを確認してください'); }
    return slot;
  }
  schedule(guild) {
    if (this.scheduled.has(guild.id)) return;
    const timer = setTimeout(() => {
      this.scheduled.delete(guild.id);
      this.restoreWatch(guild).catch(e => this.warn(guild.id, e.message));
    }, 100);
    this.scheduled.set(guild.id, timer);
  }
  async restoreWatch(guild) {
    if (!this.client.isReady() || !guild.available) return;
    const config = this.settings.get(guild.id);
    const slot = this.slots.get(guild.id);
    if (this.musicBusy(guild.id)) {
      if (slot && (humans(guild, slot.channelId).length === 0 || forbiddenVoice(guild, config, slot.channelId))) {
        this.musicEmpty(guild.id, slot.channelId);
      }
      return;
    }
    if (this.joining.has(guild.id)) { this.schedule(guild); return; }
    const channelId = chooseVoice(guild, config, slot?.channelId);
    if (!channelId) { this.destroy(guild.id); return; }
    if (slot?.channelId === channelId && slot.connection.state.status === VoiceConnectionStatus.Ready) return;
    await this.join(guild, channelId);
    // Someone may have left or /afkch may have changed while connecting.
    this.schedule(guild);
  }
  destroy(id) {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    if (slot.connection.state.status !== VoiceConnectionStatus.Destroyed) slot.connection.destroy();
    this.emit('coverage', id);
  }
}
