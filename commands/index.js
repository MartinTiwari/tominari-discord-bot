'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../utils/logger')('commands');

/**
 * Loads every command module in this folder. Each module exports either a
 * single {data, execute} object or an array of them, so related commands can
 * live in one file.
 */

function loadCommands() {
  const commands = new Map();

  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.js') && f !== 'index.js');

  for (const file of files) {
    let mod;
    try {
      mod = require(path.join(__dirname, file));
    } catch (err) {
      log.error(`Failed to load ${file}: ${err.message}`);
      continue;
    }

    for (const cmd of Array.isArray(mod) ? mod : [mod]) {
      if (!cmd?.data?.name || typeof cmd.execute !== 'function') {
        log.warn(`Skipping malformed command in ${file}`);
        continue;
      }
      if (commands.has(cmd.data.name)) {
        log.warn(`Duplicate command name "${cmd.data.name}" in ${file} — keeping the first`);
        continue;
      }
      commands.set(cmd.data.name, cmd);
    }
  }

  log.info(`Loaded ${commands.size} commands from ${files.length} files`);
  return commands;
}

module.exports = { loadCommands };
