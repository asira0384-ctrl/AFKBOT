import 'dotenv/config';
import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';
import { Settings } from './settings.js';
import { Voices } from './voices.js';
import { Afk } from './afk.js';
import { AfkMutes } from './afk-mutes.js';
import { Music } from './music.js';
import { register } from './register.js';
import { handleAfk, handleAfkChannel, helpText } from './commands.js';

if (!process.env.DISCORD_TOKEN) throw new Error('Railway VariablesにDISCORD_TOKENを設定してください');
for (const [name, fallback, min, max] of [['MAX_TRACK_SECONDS',3600,30,86400], ['MAX_QUEUE',100,1,200], ['MAX_ATTACHMENT_MB',25,1,100]]) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}は${min}〜${max}の整数にしてください`);
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], allowedMentions: { parse: [], repliedUser: false } });
const settings = new Settings(process.env.DATA_DIR || './data');
const voices = new Voices(client, settings);
const mutes = new AfkMutes(client, settings);
const afk = new Afk(client, settings, voices, mutes);
const music = new Music(client, voices);
const prefix = process.env.PREFIX || '!';
const musicCommands = new Set(['p','play','s','skip','q','queue','stop','leave','pause','resume','volume','clear','shuffle','np','nowplaying']);
const cooldowns = new Map();

client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag}`);
  try { await register(c.user.id, process.env.DISCORD_TOKEN); }
  catch (e) { console.error('Command registration failed:', e.message); }
  mutes.start(); afk.start();
  for (const guild of client.guilds.cache.values()) voices.restoreWatch(guild).catch(e => voices.warn(guild.id, e.message));
});
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;
  try {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let content;
    if (i.commandName === 'help') content = helpText.replaceAll('!', prefix);
    else if (i.commandName === 'afkch') content = await handleAfkChannel(i, settings, afk, voices);
    else if (i.commandName === 'afk') content = await handleAfk(i, settings, afk, voices);
    else return;
    await i.editReply({ content, allowedMentions: { parse: [] } });
  } catch (e) {
    console.warn('Command:', e.message);
    const payload = { content: `設定できません：${e.message}`.slice(0, 1900), allowedMentions: { parse: [] } };
    try { if (i.deferred || i.replied) await i.editReply(payload); else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }); } catch {}
  }
});
client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot || !message.content.startsWith(prefix)) return;
  const raw = message.content.slice(prefix.length).trim();
  const split = raw.search(/\s/);
  const command = (split < 0 ? raw : raw.slice(0, split)).toLowerCase();
  const args = split < 0 ? '' : raw.slice(split).trim();
  if (!musicCommands.has(command) && command !== 'help') return;
  try {
    if (command === 'help') return await message.reply(helpText.replaceAll('!', prefix));
    if (!message.member) message.member = await message.guild.members.fetch(message.author.id);
    if (command === 'p' || command === 'play') {
      const key = `${message.guildId}:${message.author.id}`;
      if ((cooldowns.get(key) || 0) > Date.now()) throw new Error('再生リクエストは3秒空けて送信してください');
      cooldowns.set(key, Date.now() + 3000);
      if (cooldowns.size > 10000) for (const [k, expiry] of cooldowns) if (expiry < Date.now()) cooldowns.delete(k);
    }
    await music.handle(message, command, args);
  } catch (e) {
    console.warn('Music command:', e.message);
    try { await message.reply({ content: `❌ ${e.message}`.slice(0, 1800), allowedMentions: { parse: [], repliedUser: false } }); } catch {}
  }
});
client.on(Events.Error, e => console.error('Discord:', e.message));
client.on('warn', text => console.warn('Discord:', text));
process.on('unhandledRejection', e => console.error('Unhandled:', e instanceof Error ? e.message : String(e)));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  mutes.stop(); afk.stop(); music.shutdown();
  for (const id of [...voices.slots.keys()]) voices.destroy(id);
  client.destroy(); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
await client.login(process.env.DISCORD_TOKEN);
