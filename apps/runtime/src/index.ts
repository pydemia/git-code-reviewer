#!/usr/bin/env node
import { loadConfig } from './config.js';
import { migrate, retention, serve, worker } from './commands.js';

const command = process.argv[2] ?? 'serve';
const config = loadConfig();

try {
  switch (command) {
    case 'serve':
      await serve(config);
      break;
    case 'worker':
      await worker(config);
      break;
    case 'migrate':
      await migrate(config);
      break;
    case 'retention':
      await retention(config, process.argv.includes('--reconcile'));
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown runtime error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
