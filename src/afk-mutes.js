// Persist Bot-managed AFK mutes so restarts and disconnects cannot strand users.
export class AfkMutes {
  constructor(client, settings) {
    this.client = client; this.settings = settings; this.locks = new Map();
    this.retryAfter = new Map(); this.busy = false;
    client.on('voiceStateUpdate', (old, next) => {
      const entry = this.entry(next.guild.id, next.id);
      if (!entry) return;
      const departed = old.channelId === entry.channel && next.channelId !== entry.channel;
      this.sync(next.guild, next.id, departed).catch(e => this.report(next.guild.id, next.id, e));
    });
  }
  entry(guildId, userId) { return this.settings.get(guildId).managedMutes[userId]; }
  save(guildId, userId, entry) {
    const users = { ...this.settings.get(guildId).managedMutes };
    if (entry) users[userId] = entry; else delete users[userId];
    this.settings.update(guildId, { managedMutes: users });
  }
  async locked(key, work) {
    const job = (this.locks.get(key) || Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(key, job);
    try { return await job; } finally { if (this.locks.get(key) === job) this.locks.delete(key); }
  }
  async move(member, target, reason) {
    const guildId = member.guild.id, userId = member.id;
    return this.locked(`${guildId}:${userId}`, async () => {
      const previous = this.entry(guildId, userId);
      this.save(guildId, userId, { channel: target.id, release: false });
      try {
        // One request moves the member and sets both server flags together.
        await member.edit({ channel: target.id, mute: true, deaf: true, reason });
        this.retryAfter.delete(`${guildId}:${userId}`);
      } catch (e) {
        this.save(guildId, userId, previous);
        throw e;
      }
    });
  }
  async sync(guild, userId, departed = false) {
    return this.locked(`${guild.id}:${userId}`, async () => {
      let entry = this.entry(guild.id, userId);
      if (!entry || !guild.available) return;
      if (departed && !entry.release) { entry = { ...entry, release: true }; this.save(guild.id, userId, entry); }
      const voice = guild.voiceStates.cache.get(userId);
      if (!voice?.channelId) {
        if (!entry.release) this.save(guild.id, userId, { ...entry, release: true });
        // Discord rejects mute/deaf updates when disconnected. Clear on next join.
        return;
      }
      if (!entry.release && voice.channelId === entry.channel) return;
      if (!entry.release) { entry = { ...entry, release: true }; this.save(guild.id, userId, entry); }
      const key = `${guild.id}:${userId}`;
      if ((this.retryAfter.get(key) || 0) > Date.now()) return;
      const member = voice.member ?? await guild.members.fetch(userId);
      await member.edit({ mute: false, deaf: false, reason: 'AFK VC退出：Botによるサーバーミュート・スピーカーミュート解除' });
      this.save(guild.id, userId, null);
      this.retryAfter.delete(key);
    });
  }
  report(guildId, userId, error) {
    this.retryAfter.set(`${guildId}:${userId}`, Date.now() + 15000);
    console.warn(`[AFK mute ${guildId}/${userId}] 解除失敗：${error.message}（再試行します）`);
  }
  async tick() {
    if (this.busy || !this.client.isReady()) return;
    this.busy = true;
    try {
      for (const guild of this.client.guilds.cache.values()) {
        if (!guild.available) continue;
        for (const id of Object.keys(this.settings.get(guild.id).managedMutes)) {
          try { await this.sync(guild, id); } catch (e) { this.report(guild.id, id, e); }
        }
      }
    } finally { this.busy = false; }
  }
  start() {
    this.tick().catch(e => console.warn('AFK mutes:', e.message));
    this.timer = setInterval(() => this.tick().catch(e => console.warn('AFK mutes:', e.message)), 5000);
  }
  stop() { clearInterval(this.timer); }
}
