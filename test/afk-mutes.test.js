import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Settings } from '../src/settings.js';
import { AfkMutes } from '../src/afk-mutes.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'afk-mutes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = new Settings(dir);
  const client = new EventEmitter(); client.isReady = () => true;
  const guild = { id: 'guild', available: true, voiceStates: { cache: new Map() } };
  client.guilds = { cache: new Map([[guild.id, guild]]) };
  const edits = [];
  const member = { id: 'user', guild, edit: async payload => {
    edits.push(payload);
    if (payload.channel) voice.channelId = payload.channel;
    voice.serverMute = payload.mute; voice.serverDeaf = payload.deaf;
  } };
  const voice = { channelId: 'chat', member, serverMute: false, serverDeaf: false, selfMute: true, selfDeaf: true };
  guild.voiceStates.cache.set(member.id, voice);
  return { dir, settings, client, guild, member, voice, edits, mutes: new AfkMutes(client, settings) };
}
test('AFK move sets mute and deaf with channel in one request', async t => {
  const f = fixture(t); await f.mutes.move(f.member, { id: 'afk' }, 'AFK');
  assert.deepEqual(f.edits[0], { channel: 'afk', mute: true, deaf: true, reason: 'AFK' });
  assert.equal(f.settings.get('guild').managedMutes.user.channel, 'afk');
  await f.mutes.sync(f.guild, 'user'); assert.equal(f.edits.length, 1);
});
test('leaving AFK for another channel clears both server flags only', async t => {
  const f = fixture(t); await f.mutes.move(f.member, { id: 'afk' }, 'AFK');
  f.voice.channelId = 'chat'; await f.mutes.sync(f.guild, 'user');
  assert.equal(f.voice.serverMute, false); assert.equal(f.voice.serverDeaf, false);
  assert.equal(f.voice.selfMute, true); assert.equal(f.voice.selfDeaf, true);
  assert.equal(f.settings.get('guild').managedMutes.user, undefined);
});
test('disconnect persists release and next join clears even if joining AFK again', async t => {
  const f = fixture(t); await f.mutes.move(f.member, { id: 'afk' }, 'AFK');
  f.voice.channelId = null; await f.mutes.sync(f.guild, 'user');
  assert.equal(f.edits.length, 1); assert.equal(f.settings.get('guild').managedMutes.user.release, true);
  f.voice.channelId = 'afk'; await f.mutes.sync(f.guild, 'user');
  assert.equal(f.voice.serverMute, false); assert.equal(f.voice.serverDeaf, false);
});
test('restarted Bot clears persisted AFK mute outside AFK', async t => {
  const f = fixture(t); await f.mutes.move(f.member, { id: 'afk' }, 'AFK');
  const restarted = new AfkMutes(new EventEmitter(), new Settings(f.dir));
  f.voice.channelId = 'chat'; await restarted.sync(f.guild, 'user');
  assert.equal(f.voice.serverMute, false); assert.equal(f.voice.serverDeaf, false);
  assert.equal(new Settings(f.dir).get('guild').managedMutes.user, undefined);
});
test('manual mutes and manual AFK joins are not changed', async t => {
  const f = fixture(t); f.voice.channelId = 'afk'; f.voice.serverMute = true;
  await f.mutes.sync(f.guild, 'user'); assert.equal(f.edits.length, 0); assert.equal(f.voice.serverMute, true);
});
test('failed release is preserved for retry', async t => {
  const f = fixture(t); await f.mutes.move(f.member, { id: 'afk' }, 'AFK');
  f.voice.channelId = 'chat'; const original = f.member.edit;
  f.member.edit = async () => { throw new Error('Missing Permissions'); };
  await assert.rejects(() => f.mutes.sync(f.guild, 'user'));
  assert.equal(f.settings.get('guild').managedMutes.user.release, true);
  f.member.edit = original; await f.mutes.sync(f.guild, 'user');
  assert.equal(f.settings.get('guild').managedMutes.user, undefined);
});
test('failed AFK move does not take ownership of unrelated mutes', async t => {
  const f = fixture(t); f.member.edit = async () => { throw new Error('Missing Permissions'); };
  await assert.rejects(() => f.mutes.move(f.member, { id: 'afk' }, 'AFK'));
  assert.equal(f.settings.get('guild').managedMutes.user, undefined);
});
test('leave event arriving during AFK move is processed after move completes', async t => {
  const f = fixture(t); const original = f.member.edit;
  f.member.edit = async payload => {
    await original(payload);
    if (payload.channel) { f.voice.channelId = 'chat'; f.client.emit('voiceStateUpdate', {}, { ...f.voice, id: 'user', guild: f.guild }); }
  };
  await f.mutes.move(f.member, { id: 'afk' }, 'AFK');
  await f.mutes.sync(f.guild, 'user');
  assert.equal(f.voice.serverMute, false); assert.equal(f.voice.serverDeaf, false);
  assert.equal(f.settings.get('guild').managedMutes.user, undefined);
});
