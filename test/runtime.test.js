import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { Music } from '../src/music.js';
import { commands } from '../src/commands.js';
import { Afk } from '../src/afk.js';
import { defaults } from '../src/settings.js';
import { EventEmitter } from 'node:events';

test('generated slash command payload is within Discord limits', () => {
  for (const c of commands) {
    assert.ok(c.name.length <= 32); assert.ok(c.description.length <= 100);
    assert.ok((c.options?.length || 0) <= 25);
    for (const s of c.options || []) assert.ok(s.options?.length <= 25 || !s.options);
  }
});
test('FFmpeg raw PCM is encoded into Opus packets', async t => {
  const check = spawn('ffmpeg', ['-version']);
  const exists = await new Promise(resolve => { check.once('error', () => resolve(false)); check.once('close', c => resolve(c === 0)); });
  if (!exists) { t.skip('FFmpeg not installed on this test host'); return; }
  const child = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.2','-f','s16le','-ar','48000','-ac','2','pipe:1']);
  const audio = createAudioResource(child.stdout, { inputType: StreamType.Raw, inlineVolume: true });
  audio.volume.setVolume(0.5);
  let packets = 0;
  for await (const packet of audio.playStream) { assert.ok(packet.length > 0); packets++; }
  assert.ok(packets > 0);
});
test('skip and stop cancel loading and preserve or clear the queue', () => {
  const voices = { restoreWatch: async () => {}, warn: () => {} };
  const client = new EventEmitter(); client.rest = { put: async () => {} };
  const music = new Music(client, voices);
  const s = music.session({ id: 'guild' });
  s.pumping = true; s.abort = new AbortController(); s.queue = [{ title: 'next' }];
  music.skip(s); assert.ok(s.abort.signal.aborted); assert.equal(s.queue.length, 1);
  s.abort = new AbortController(); music.stop(s); assert.equal(s.queue.length, 0); assert.ok(s.abort.signal.aborted);
  assert.equal(s.generation, 2); music.shutdown();
});
test('AFK move rechecks screen sharing after channel lookup', async () => {
  const client = new EventEmitter(); client.isReady = () => true;
  const voices = new EventEmitter(); voices.isMonitored = () => true; voices.isSpeaking = () => false;
  const config = { ...defaults(), enabled: true, muteTarget: 'afk', silenceTarget: 'afk', muteSeconds: 1 };
  const settings = { get: () => config };
  const afk = new Afk(client, settings, voices);
  let moved = false;
  const member = { id: 'user', user: { bot: false }, roles: { cache: new Map() },
    voice: { channelId: 'chat', selfMute: true, streaming: false, channel: { permissionsFor: () => ({ has: () => true }) }, setChannel: async () => { moved = true; } } };
  const guild = { id: 'guild', members: { me: {} }, channels: { fetch: async () => {
    member.voice.streaming = true;
    return { id: 'afk', type: 2, permissionsFor: () => ({ has: () => true }) };
  } } };
  const record = { channel: 'chat', muteSince: 0, lastSpeech: 0, retryAfter: 0, moving: false };
  await afk.move(guild, member, record, 'mute', config);
  assert.equal(moved, false); assert.equal(record.moving, false);
});
