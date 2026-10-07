import { ChannelType, PermissionFlagsBits } from 'discord.js';

export function humans(guild, channelId) {
  return [...guild.voiceStates.cache.values()].filter(v => v.channelId === channelId && v.member && !v.member.user.bot);
}
export function forbiddenVoice(guild, config, channelId) {
  return !channelId || [config.muteTarget, config.silenceTarget, guild.afkChannelId].includes(channelId)
    || config.ignoredChannels.includes(channelId);
}
export function chooseVoice(guild, config, currentId) {
  if (!config.enabled) return null;
  const eligible = channel => channel?.type === ChannelType.GuildVoice
    && !forbiddenVoice(guild, config, channel.id) && humans(guild, channel.id).length > 0
    && channel.permissionsFor(guild.members.me)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak,
    ]);
  const current = guild.channels.cache.get(currentId);
  if (eligible(current)) return current.id;
  return [...guild.channels.cache.values()].filter(eligible)
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0) || a.id.localeCompare(b.id))[0]?.id ?? null;
}
