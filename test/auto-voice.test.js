import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { defaults } from '../src/settings.js';
import { chooseVoice, humans } from '../src/auto-voice.js';
import { Voices } from '../src/voices.js';
import { handleAfkChannel } from '../src/commands.js';

function fixture() {
  const channel = (id, position = 0) => ({ id, type: 2, rawPosition: position, permissionsFor: () => ({ has: () => true }) });
  const guild = { id: 'guild', available: true, afkChannelId: 'builtin-afk', members: { me: {} },
    channels: { cache: new Map([['one', channel('one')], ['two', channel('two', 1)], ['afk', channel('afk')], ['builtin-afk', channel('builtin-afk')]]) },
    voiceStates: { cache: new Map() } };
  const join = (id, ch, bot = false) => guild.voiceStates.cache.set(id, { channelId: ch, member: { id, user: { bot } } });
  const config = { ...defaults(), enabled: true, muteTarget: 'afk', silenceTarget: 'afk' };
  return { guild, config, join };
}
test('automatic selection joins populated VC and ignores bots and AFK destinations', () => {
  const { guild, config, join } = fixture();
  assert.equal(chooseVoice(guild, config), null);
  join('bot', 'one', true); join('sleep', 'afk'); join('builtin', 'builtin-afk');
  assert.equal(chooseVoice(guild, config), null);
  join('person', 'two'); assert.equal(chooseVoice(guild, config), 'two');
});
test('current occupied VC is kept and switches only when empty', () => {
  const { guild, config, join } = fixture();
  join('a', 'one'); join('b', 'two');
  assert.equal(chooseVoice(guild, config, 'two'), 'two');
  guild.voiceStates.cache.delete('b'); assert.equal(chooseVoice(guild, config, 'two'), 'one');
  guild.voiceStates.cache.delete('a'); assert.equal(chooseVoice(guild, config, 'one'), null);
});
test('ignored and inaccessible VC are never auto selected', () => {
  const { guild, config, join } = fixture(); join('a', 'one'); join('b', 'two');
  config.ignoredChannels = ['one']; assert.equal(chooseVoice(guild, config), 'two');
  guild.channels.cache.get('two').permissionsFor = () => ({ has: () => false });
  assert.equal(chooseVoice(guild, config), null);
});
test('automatic connection leaves when no humans remain', async () => {
  const { guild, config } = fixture();
  const client = new EventEmitter(); client.isReady = () => true;
  const voices = new Voices(client, { get: () => config });
  let destroyed = false;
  voices.slots.set(guild.id, { channelId: 'one', connection: { state: { status: 'ready' }, destroy: () => { destroyed = true; } } });
  await voices.restoreWatch(guild); assert.equal(destroyed, true); assert.equal(voices.slots.size, 0);
});
test('music is stopped when its VC is empty or becomes AFK', async () => {
  const { guild, config, join } = fixture();
  const client = new EventEmitter(); client.isReady = () => true;
  const voices = new Voices(client, { get: () => config });
  voices.musicBusy = () => true;
  let stopped = 0; voices.musicEmpty = () => stopped++;
  voices.slots.set(guild.id, { channelId: 'one' });
  await voices.restoreWatch(guild); assert.equal(stopped, 1);
  join('a', 'one'); await voices.restoreWatch(guild); assert.equal(stopped, 1);
  config.muteTarget = 'one'; config.silenceTarget = 'one';
  await voices.restoreWatch(guild); assert.equal(stopped, 2);
});
test('/afkch sets both targets, enables monitoring and clears legacy watch setting', async () => {
  let saved, reset = false, reconciled = false;
  const i = { inGuild: () => true, guildId: 'guild', guild: {}, memberPermissions: { has: () => true },
    options: { getChannel: () => ({ id: 'afk', type: 2 }) } };
  const result = await handleAfkChannel(i, { update: (_, patch) => { saved = patch; } },
    { resetGuild: () => { reset = true; } }, { restoreWatch: async () => { reconciled = true; } });
  assert.equal(saved.muteTarget, 'afk'); assert.equal(saved.silenceTarget, 'afk');
  assert.equal(saved.watchChannel, null); assert.equal(saved.enabled, true);
  assert.ok(reset && reconciled); assert.ok(result.includes('afk'));
});
