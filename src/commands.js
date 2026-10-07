import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';

const kinds = [
  { name: 'ミュート・無言の両方', value: 'both' },
  { name: 'セルフミュートのみ', value: 'mute' },
  { name: '無言のみ', value: 'silence' },
];
export const commands = [new SlashCommandBuilder().setName('afk').setDescription('AFK移動の設定')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
  .addSubcommand(s => s.setName('setup').setDescription('時間と移動先を設定してAFKを有効にする')
    .addChannelOption(o => o.setName('target').setDescription('共通の移動先VC').addChannelTypes(ChannelType.GuildVoice).setRequired(true))
    .addIntegerOption(o => o.setName('mute_seconds').setDescription('セルフミュートの秒数。0で無効').setMinValue(0).setMaxValue(86400))
    .addIntegerOption(o => o.setName('silence_seconds').setDescription('無言の秒数。0で無効').setMinValue(0).setMaxValue(86400))
)
  .addSubcommand(s => s.setName('mute').setDescription('セルフミュートの時間と移動先を設定')
    .addIntegerOption(o => o.setName('seconds').setDescription('秒数。0で無効').setMinValue(0).setMaxValue(86400).setRequired(true))
    .addChannelOption(o => o.setName('target').setDescription('ミュート時の移動先').addChannelTypes(ChannelType.GuildVoice)))
  .addSubcommand(s => s.setName('silence').setDescription('無言の時間と移動先を設定')
    .addIntegerOption(o => o.setName('seconds').setDescription('秒数。0で無効').setMinValue(0).setMaxValue(86400).setRequired(true))
    .addChannelOption(o => o.setName('target').setDescription('無言時の移動先').addChannelTypes(ChannelType.GuildVoice)))
  .addSubcommand(s => s.setName('exempt').setDescription('特定の人をAFK移動の対象から除外')
    .addUserOption(o => o.setName('user').setDescription('除外する人').setRequired(true))
    .addStringOption(o => o.setName('kind').setDescription('除外する判定。省略時は両方').addChoices(...kinds)))
  .addSubcommand(s => s.setName('unexempt').setDescription('ユーザーの除外を解除')
    .addUserOption(o => o.setName('user').setDescription('除外を解除する人').setRequired(true)))
  .addSubcommand(s => s.setName('exemptrole').setDescription('ロールをAFK移動から除外')
    .addRoleOption(o => o.setName('role').setDescription('除外するロール').setRequired(true))
    .addStringOption(o => o.setName('kind').setDescription('省略時は両方').addChoices(...kinds)))
  .addSubcommand(s => s.setName('unexemptrole').setDescription('ロールの除外を解除')
    .addRoleOption(o => o.setName('role').setDescription('対象ロール').setRequired(true)))
  .addSubcommand(s => s.setName('ignore').setDescription('VC全体をAFK移動から除外')
    .addChannelOption(o => o.setName('channel').setDescription('除外するVC').addChannelTypes(ChannelType.GuildVoice).setRequired(true)))
  .addSubcommand(s => s.setName('unignore').setDescription('VCの除外を解除')
    .addChannelOption(o => o.setName('channel').setDescription('対象VC').addChannelTypes(ChannelType.GuildVoice).setRequired(true)))
  .addSubcommand(s => s.setName('log').setDescription('移動ログの送信先を設定／解除')
    .addChannelOption(o => o.setName('channel').setDescription('省略でログ送信を解除').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('on').setDescription('AFK移動を有効にする'))
  .addSubcommand(s => s.setName('off').setDescription('AFK移動を無効にする'))
  .addSubcommand(s => s.setName('status').setDescription('設定・監視範囲・除外一覧を確認')),
new SlashCommandBuilder().setName('afkch').setDescription('ミュート・無言の移動先VCをまとめて設定し、自動監視を有効にする')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
  .addChannelOption(o => o.setName('channel').setDescription('AFK移動先VC。BotはこのVCへ自動接続しません').addChannelTypes(ChannelType.GuildVoice).setRequired(true)),
new SlashCommandBuilder().setName('help').setDescription('AFKと音楽コマンド一覧').setDMPermission(false),
].map(c => c.toJSON());

export const helpText = `**AFK設定（サーバー管理権限が必要）**
/afkch channel:AFK用VC → ミュート・無言の共通移動先を設定
/afk mute seconds:300
/afk silence seconds:600
/afk mute seconds:300 target:VC
/afk silence seconds:600 target:VC
/afk exempt user:人 → ミュート・無言の両方から除外
/afk unexempt user:人 → 除外解除
/afk exemptrole・ignore・log・on・off・status
時間は秒数。0で該当の判定をOFF。
セルフミュートは全VC、無言はBot参加中のVCだけを監視。
画面共有中の人とBotは常に対象外。

**Music**
!p 曲名 / !play YouTubeリンク / !p Spotifyリンク
!p と一緒に音声ファイルを添付
!skip・!queue・!pause・!resume・!stop・!leave
!volume 0〜100・!clear・!shuffle・!np
Spotifyは曲名からYouTube検索。アルバム／プレイリストはAPIキー設定が必要。
人が入ったVCへ自動接続。人が全員いなくなったら切断。
AFK用VCへは接続しません。複数VCは現在のVCを優先。`;

export async function handleAfk(i, settings, afk, voices) {
  if (!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('サーバー管理権限が必要です');
  const sub = i.options.getSubcommand();
  const before = settings.get(i.guildId);
  let patch = {}, text;
  const channelId = name => i.options.getChannel(name)?.id;
  switch (sub) {
    case 'setup': {
      const target = channelId('target');
      patch = { enabled: true, muteTarget: target, silenceTarget: target,
        muteSeconds: i.options.getInteger('mute_seconds') ?? before.muteSeconds,
        silenceSeconds: i.options.getInteger('silence_seconds') ?? before.silenceSeconds,
        watchChannel: null };
      text = 'AFK設定を保存して有効にしました。'; break;
    }
    case 'mute': case 'silence': {
      patch[`${sub}Seconds`] = i.options.getInteger('seconds');
      if (channelId('target')) patch[`${sub}Target`] = channelId('target');
      if (patch[`${sub}Seconds`] > 0 && !(patch[`${sub}Target`] || before[`${sub}Target`])) throw new Error('target も指定してください');
      text = `${sub === 'mute' ? 'セルフミュート' : '無言'}設定を保存しました。AFK全体：${before.enabled ? 'ON' : 'OFF（/afk on で有効化）'}`; break;
    }
    case 'exempt': case 'unexempt': {
      const user = i.options.getUser('user'); const users = { ...before.exemptUsers };
      if (sub === 'exempt') users[user.id] = i.options.getString('kind') ?? 'both'; else delete users[user.id];
      patch.exemptUsers = users; text = `${user.tag} の除外を${sub === 'exempt' ? '設定' : '解除'}しました。`; break;
    }
    case 'exemptrole': case 'unexemptrole': {
      const role = i.options.getRole('role'); const roles = { ...before.exemptRoles };
      if (sub === 'exemptrole') roles[role.id] = i.options.getString('kind') ?? 'both'; else delete roles[role.id];
      patch.exemptRoles = roles; text = `${role.name} の除外を${sub === 'exemptrole' ? '設定' : '解除'}しました。`; break;
    }
    case 'ignore': case 'unignore': {
      const id = channelId('channel'); const ignored = new Set(before.ignoredChannels);
      if (sub === 'ignore') ignored.add(id);
      else ignored.delete(id);
      patch.ignoredChannels = [...ignored]; text = 'VCの除外設定を更新しました。'; break;
    }
    case 'log': patch.logChannel = channelId('channel') ?? null; text = patch.logChannel ? 'ログ送信先を設定しました。' : 'ログ送信を解除しました。'; break;
    case 'on':
      if (before.muteSeconds > 0 && !before.muteTarget || before.silenceSeconds > 0 && !before.silenceTarget) throw new Error('先に /afkch で移動先を設定してください');
      patch.enabled = true; text = 'AFK移動を有効にしました。'; break;
    case 'off': patch.enabled = false; text = 'AFK移動を無効にしました。音楽機能は使えます。'; break;
    case 'status': {
      const vc = id => id ? `<#${id}>` : '未設定';
      const users = Object.entries(before.exemptUsers).map(([id, kind]) => `<@${id}> (${kind})`).join(', ') || 'なし';
      const roles = Object.entries(before.exemptRoles).map(([id, kind]) => `<@&${id}> (${kind})`).join(', ') || 'なし';
      const slot = voices.slots.get(i.guildId);
      text = `AFK：${before.enabled ? 'ON' : 'OFF'}\nセルフミュート：${before.muteSeconds}秒 → ${vc(before.muteTarget)}\n無言：${before.silenceSeconds}秒 → ${vc(before.silenceTarget)}\nVC接続：自動（人がいるVC／AFK用VCは除外）\n現在のBot参加VC：${vc(slot?.channelId)}\n無言受信：${slot && voices.isMonitored(i.guildId, slot.channelId) ? '接続中' : '停止中'}\n画面共有：常に除外\nユーザー除外：${users}\nロール除外：${roles}\n除外VC：${before.ignoredChannels.map(vc).join(', ') || 'なし'}\nログ：${vc(before.logChannel)}\n無言判定はBot参加中のVCだけです。`; break;
    }
    default: throw new Error('不明なコマンドです');
  }
  if (Object.keys(patch).length) {
    settings.update(i.guildId, patch); afk.resetGuild(i.guildId);
    try { await voices.restoreWatch(i.guild); }
    catch (e) { text += `\n設定は保存済みですがVC接続に失敗：${e.message}`; }
  }
  return text.slice(0, 1950);
}

export async function handleAfkChannel(i, settings, afk, voices) {
  if (!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('サーバー管理権限が必要です');
  const channel = i.options.getChannel('channel', true);
  if (channel.type !== ChannelType.GuildVoice) throw new Error('通常のVCを指定してください');
  settings.update(i.guildId, { enabled: true, muteTarget: channel.id, silenceTarget: channel.id, watchChannel: null });
  afk.resetGuild(i.guildId);
  let text = `AFK移動先を <#${channel.id}> に設定しました。\nセルフミュート・無言の両方がこのVCへ移動します。\n人がいるVCへ自動接続します。AFK用VCには接続しません。`;
  try { await voices.restoreWatch(i.guild); }
  catch (e) { text += `\n設定は保存済みですがVC接続に失敗：${e.message}`; }
  return text;
}
