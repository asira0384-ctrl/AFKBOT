import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
export async function register(clientId, token) {
  const rest = new REST({ version: '10' }).setToken(token);
  const route = process.env.GUILD_ID ? Routes.applicationGuildCommands(clientId, process.env.GUILD_ID) : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
  console.log(`Commands registered (${process.env.GUILD_ID ? 'guild' : 'global'})`);
}
if (process.argv[1]?.endsWith('/register.js')) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKENを設定してください');
  const rest = new REST({ version: '10' }).setToken(token);
  const app = await rest.get('/oauth2/applications/@me');
  await register(app.id, token);
}
