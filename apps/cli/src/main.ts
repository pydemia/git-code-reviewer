#!/usr/bin/env node
import { executeCli } from './cli.js';

const controller = new AbortController();
const cancel = () => {
  controller.abort();
  if (!process.stdin.isTTY) process.stdin.destroy();
};
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
process.stdout.on('error', () => {
  controller.abort();
  process.exitCode = 2;
});
const result = await executeCli(process.argv.slice(2), {
  signal: controller.signal,
  readStdin: async () => {
    if (process.stdin.isTTY) throw new Error('stdin-required');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      if (controller.signal.aborted) throw new Error('cancelled');
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 2_000_000) throw new Error('input-limit');
      chunks.push(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  },
});
process.removeListener('SIGINT', cancel);
process.removeListener('SIGTERM', cancel);
if (result.diagnostics)
  for (const diagnostic of result.diagnostics)
    process.stderr.write(JSON.stringify(diagnostic) + '\n');
process.stdout.write(
  result.text ? String(result.value) : JSON.stringify(result.value, null, 2) + '\n',
);
process.exitCode = result.exitCode;
