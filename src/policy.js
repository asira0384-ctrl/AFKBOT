export function applies(scope, kind) { return scope === 'both' || scope === kind; }
export function exempt(config, member, kind) {
  if (applies(config.exemptUsers[member.id], kind)) return true;
  return [...member.roles.cache.keys()].some(id => applies(config.exemptRoles[id], kind));
}
export function resetRecord(voice, now) {
  return { channel: voice.channelId, muteSince: voice.selfMute ? now : null,
    lastSpeech: now, retryAfter: 0, moving: false };
}
export function updateRecord(record, oldVoice, voice, now) {
  if (!record || record.channel !== voice.channelId) return resetRecord(voice, now);
  if (!voice.selfMute) record.muteSince = null;
  else if (!oldVoice.selfMute || record.muteSince === null) record.muteSince = now;
  // Screen share and exemption changes give a fresh grace period when they end.
  if (oldVoice.streaming !== voice.streaming) {
    record.lastSpeech = now;
    record.muteSince = voice.selfMute ? now : null;
  }
  return record;
}
export function dueReason({ config, voice, member, record, now, monitored, speaking }) {
  if (!config.enabled || !voice.channelId || member.user.bot || voice.streaming || record.moving || record.retryAfter > now) return null;
  if (config.ignoredChannels.includes(voice.channelId)) return null;
  // Both destination channels are safe zones, even if rules use different destinations.
  if ([config.muteTarget, config.silenceTarget].includes(voice.channelId)) return null;
  if (config.muteSeconds > 0 && config.muteTarget && voice.selfMute && record.muteSince !== null
      && now - record.muteSince >= config.muteSeconds * 1000 && !exempt(config, member, 'mute')) return 'mute';
  if (config.silenceSeconds > 0 && config.silenceTarget && monitored && !speaking
      && now - record.lastSpeech >= config.silenceSeconds * 1000 && !exempt(config, member, 'silence')) return 'silence';
  return null;
}
