import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, Settings } from '../src/settings.js';
import { resetRecord, updateRecord, dueReason } from '../src/policy.js';
import { parseInput, attachmentTrack } from '../src/sources.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function fixture() {
  return { config: { ...defaults(), enabled: true, muteTarget: 'afk', silenceTarget: 'afk', muteSeconds: 60, silenceSeconds: 120 },
    voice: { channelId: 'chat', selfMute: true, streaming: false },
    member: { id: 'user', user: { bot: false }, roles: { cache: new Map([['member', {}]]) } },
    record: { channel: 'chat', muteSince: 0, lastSpeech: 0, moving: false, retryAfter: 0 },
    now: 61000, monitored: false, speaking: false };
}
test('only uninterrupted self-mute passes its threshold', () => {
  const f = fixture(); assert.equal(dueReason(f), 'mute');
  f.voice.selfMute = false; assert.equal(dueReason(f), null);
  const r = updateRecord(f.record, { selfMute: true }, f.voice, 50000);
  assert.equal(r.muteSince, null);
  f.voice.selfMute = true;
  updateRecord(r, { selfMute: false }, f.voice, 60000);
  assert.equal(r.muteSince, 60000);
  assert.equal(dueReason({ ...f, record: r }), null);
});
test('silence never moves someone in an unmonitored VC or currently speaking', () => {
  const f = fixture(); f.voice.selfMute = false; f.now = 121000;
  assert.equal(dueReason(f), null);
  f.monitored = true; assert.equal(dueReason(f), 'silence');
  f.speaking = true; assert.equal(dueReason(f), null);
});
test('screen sharing, bots, destinations and ignored channels are safe', () => {
  const f = fixture();
  f.voice.streaming = true; assert.equal(dueReason(f), null);
  f.voice.streaming = false; f.member.user.bot = true; assert.equal(dueReason(f), null);
  f.member.user.bot = false; f.voice.channelId = 'afk'; assert.equal(dueReason(f), null);
  f.voice.channelId = 'chat'; f.config.ignoredChannels = ['chat']; assert.equal(dueReason(f), null);
});
test('sharing end and channel changes restart grace periods', () => {
  const f = fixture();
  updateRecord(f.record, { selfMute: true, streaming: true }, f.voice, 61000);
  assert.equal(f.record.muteSince, 61000); assert.equal(f.record.lastSpeech, 61000);
  f.voice.channelId = 'other';
  const r = updateRecord(f.record, f.voice, f.voice, 80000);
  assert.deepEqual(r, resetRecord(f.voice, 80000));
});
test('user and role exemptions have explicit scopes', () => {
  const f = fixture(); f.config.exemptUsers.user = 'both'; assert.equal(dueReason(f), null);
  f.config.exemptUsers.user = 'silence'; assert.equal(dueReason(f), 'mute');
  delete f.config.exemptUsers.user; f.config.exemptRoles.member = 'mute'; assert.equal(dueReason(f), null);
  f.voice.selfMute = false; f.monitored = true; f.now = 121000; assert.equal(dueReason(f), 'silence');
});
test('disabled rules and movement retries do not move', () => {
  const f = fixture(); f.config.muteSeconds = 0; assert.equal(dueReason(f), null);
  f.config.muteSeconds = 60; f.record.moving = true; assert.equal(dueReason(f), null);
  f.record.moving = false; f.record.retryAfter = 90000; assert.equal(dueReason(f), null);
  f.record.retryAfter = 0; f.config.enabled = false; assert.equal(dueReason(f), null);
});
test('settings and exemptions persist on a fresh process instance', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'afk-test-'));
  try {
    new Settings(dir).update('guild', { enabled: true, exemptUsers: { user: 'both' }, muteSeconds: 12 });
    const c = new Settings(dir).get('guild'); assert.equal(c.muteSeconds, 12); assert.equal(c.exemptUsers.user, 'both');
    writeFileSync(path.join(dir, 'settings.json'), '{broken');
    assert.throws(() => new Settings(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('searches, supported links and arbitrary URL rejection', () => {
  assert.equal(parseInput('好きな曲').type, 'search');
  assert.equal(parseInput('https://youtu.be/dQw4w9WgXcQ?t=4').value, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(parseInput('https://www.youtube.com/shorts/dQw4w9WgXcQ').type, 'youtube');
  assert.equal(parseInput('https://open.spotify.com/intl-ja/track/11dFghVXANMlKmJXsNCbNl?si=abc').kind, 'track');
  for (const s of ['https://127.0.0.1/audio.mp3', 'https://youtube.com.attacker.test/watch?v=dQw4w9WgXcQ', 'https://youtube.com/playlist?list=x', 'https://u:p@youtube.com/watch?v=dQw4w9WgXcQ']) assert.throws(() => parseInput(s));
});
test('attachments must be Discord media and within limit', () => {
  assert.equal(attachmentTrack({ name: 'song.mp3', size: 1000, url: 'https://cdn.discordapp.com/attachments/a/b/song.mp3' }).type, 'file');
  assert.throws(() => attachmentTrack({ name: 'song.mp3', size: 1000, url: 'https://127.0.0.1/song.mp3' }));
  assert.throws(() => attachmentTrack({ name: 'song.mp3', size: 999999999, url: 'https://cdn.discordapp.com/x' }));
});
