'use strict';

require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { loadCommands } = require('./commands');
const log = require('./utils/logger')('deploy');

/**
 * Registers slash commands with Discord.
 *
 * With DISCORD_GUILD_ID set, commands register to that one server and appear
 * instantly — use this while developing. Without it they register globally,
 * which can take up to an hour to propagate.
 *
 *   npm run deploy
 */

async function main() {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
    log.error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env');
    process.exit(1);
  }

  const commands = loadCommands();
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID);

  log.info(`Registering ${body.length} commands ${DISCORD_GUILD_ID ? `to guild ${DISCORD_GUILD_ID}` : 'globally'}…`);

  try {
    const result = await rest.put(route, { body });
    log.info(`✅ Registered ${result.length} commands: ${result.map((c) => `/${c.name}`).join(' ')}`);
    if (!DISCORD_GUILD_ID) log.info('Global commands can take up to an hour to appear.');
  } catch (err) {
    log.error(`Registration failed: ${err.message}`);
    if (err.rawError?.errors) log.error(JSON.stringify(err.rawError.errors, null, 2));
    process.exit(1);
  }
}

main();
