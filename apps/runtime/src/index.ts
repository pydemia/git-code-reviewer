#!/usr/bin/env node
import { loadConfig } from './config.js';
import { migrate, retention, serve, worker } from './commands.js';

const command = process.argv[2] ?? 'serve';

try {
  switch (command) {
    case 'serve':
      await serve(loadConfig(process.env, command));
      break;
    case 'worker':
      await worker(loadConfig(process.env, command));
      break;
    case 'migrate':
      await migrate(loadConfig(process.env, command));
      break;
    case 'retention':
      await retention(loadConfig(process.env, command), process.argv.includes('--reconcile'));
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown runtime error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
