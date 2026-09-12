import { parseArgs } from 'node:util';

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const help = `Usage: gcr <command> [options]

Commands:
  status [--check-executor]            Local identity and supported capabilities
  context                              Fixed snapshot and active knowledge selection
  review                               Review and save an encrypted terminal report
  result <run-id>                       Read a saved report (same review exit code)
  history                              List saved review summaries
  memory|skill list|show <id>
  memory|skill create --input <json-file|->
  memory|skill edit <id> --revision <n> --input <json-file|->
  memory|skill activate|deactivate|archive|delete <id> --revision <n>
  memory|skill import --input <export-json|->
  memory|skill export <id> --output <new-file>

Common: --cwd <repo> --profile <id> --data-dir <private-directory>
        --mode standalone|centralized (centralized is unavailable) --json
Knowledge: --scope repository|profile (default repository)
Snapshot: --source index|working-tree (default index) --base <ref>
          --path <exact-path> (repeatable) --include-untracked <path> (working-tree only)
          --exclude <glob> --require-source <source|base>:<path> --require-knowledge <id>
Review: --executor-path <codex-binary> --model gpt-6-astra --reasoning-effort xhigh
        --allow-path <glob> (default **; includes fixed base and related files)
        --timeout-ms <1..600000> --source-bytes <1..33554432> --tool-calls <1..1000>

review explicitly permits the selected account executor to read the approved fixed
repository snapshot and active local knowledge. No central server is contacted.
Results are JSON; diagnostics go to stderr. Exit 0: complete/no follow-up;
1: complete/findings or optional questions; 2: incomplete, unavailable or command error.
create/import starts a candidate; activate is a separate explicit action.
`;
const common = ['cwd', 'profile', 'data-dir', 'mode', 'json', 'help'];
const snapshot = [
  'source',
  'base',
  'path',
  'include-untracked',
  'exclude',
  'require-source',
  'require-knowledge',
];
const executor = ['executor-path', 'model', 'reasoning-effort'];
const allowed: Record<string, string[]> = {
  status: ['check-executor', ...executor],
  context: snapshot,
  review: [...snapshot, ...executor, 'allow-path', 'timeout-ms', 'source-bytes', 'tool-calls'],
  result: [],
  history: [],
  memory: ['scope', 'input', 'output', 'revision'],
  skill: ['scope', 'input', 'output', 'revision'],
};
const multiple = new Set([
  'path',
  'include-untracked',
  'exclude',
  'require-source',
  'require-knowledge',
  'allow-path',
]);
const boolean = new Set(['json', 'help', 'check-executor']);
export function argumentsFor(argv: string[]) {
  if (!argv.length || argv[0] === '--help' || argv[0] === 'help')
    return { command: 'help', positionals: [], values: {} };
  const command = argv[0]!;
  if (!Object.hasOwn(allowed, command))
    throw new CliError('usage', 'Unknown command. Run gcr --help.');
  const options = Object.fromEntries(
    [...common, ...allowed[command]!].map((name) => [
      name,
      {
        type: boolean.has(name) ? ('boolean' as const) : ('string' as const),
        ...(multiple.has(name) ? { multiple: true } : {}),
      },
    ]),
  );
  try {
    const parsed = parseArgs({
      args: argv.slice(1),
      options,
      strict: true,
      allowPositionals: true,
    });
    return { command, ...parsed };
  } catch {
    throw new CliError('usage', 'Invalid or unsupported option. Run gcr --help.');
  }
}
