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
  central connect --input <config.json> --api-key-stdin
  central list|status|sync|disconnect  Explicit central connection management
  status [--check-executor]            Local identity and supported capabilities
  context                              Fixed snapshot and active knowledge selection
  review                               Review and save an encrypted terminal report
  push-review                          Review every ref from pre-push stdin (foreground)
  service start|run|status|stop          Manage the profile's independent local service
  service allow|revoke|registrations    Explicit worktree trigger/model authorization
  service job|cancel --id <receipt-id> Inspect or cancel an asynchronous request
  enqueue                              Capture source and return a durable service receipt
  enqueue-push                         Capture every pre-push ref and enqueue fixed source
  requests                             Inspect durable review ownership and outcomes
  result <run-id>                       Read a saved report (same review exit code)
  history                              List saved review summaries
  memory|skill list|show <id>
  memory|skill create --input <json-file|->
  memory|skill edit <id> --revision <n> --input <json-file|->
  memory|skill activate|deactivate|archive|delete <id> --revision <n>
  memory|skill import --input <export-json|->
  memory|skill export <id> --output <new-file>

Common: --cwd <repo> --profile <id> --data-dir <private-directory>
        --mode standalone|centralized --connection <id> --json
Knowledge: --scope repository|profile (default repository)
Central: --mode centralized is required; connect takes its API key from piped stdin.
         context/review --offline uses only an authorized unexpired signed cache.
         --offline-behavior cache-then-standalone|cache-only|standalone|pause
         New connections default to cache-then-standalone; older connections retain pause.
         connect stores this policy; context/review can override it explicitly.
Snapshot: --source index|working-tree|commit-tree (default index) --base <ref>
          --index-file <path> (index only; inherited GIT_INDEX_FILE is otherwise honored)
          commit-tree: --source-commit <oid> --base-commit <oid|empty> [--target-branch <name>]
          --path <exact-path> (repeatable) --include-untracked <path> (working-tree only)
          --exclude <glob> --require-source <source|base>:<path> --require-knowledge <id>
Review: --executor-path <codex-binary> --model gpt-6-astra --reasoning-effort xhigh
        --retry-finished (explicitly rerun a saved terminal review)
        --trigger manual|work_completed|save|stage|commit|push (default manual)
        --allow-path <glob> (default **; includes fixed base and related files)
        --timeout-ms <1..600000> --source-bytes <1..33554432> --tool-calls <1..1000>
Service: allow requires explicit --trigger values (repeatable; replaces previous grants).
         enqueue/enqueue-push use registered settings and accept --request-id <UUID>.
         Exit 0 from enqueue confirms durable receipt, not review completion.

review explicitly permits the selected account executor to read the approved fixed
repository snapshot and selected knowledge. Standalone never contacts a central server.
Centralized requires an explicit connection ID and may synchronize before review.
Results are JSON; diagnostics go to stderr. Exit 0: complete/no follow-up;
1: complete/findings or optional questions; 2: incomplete, unavailable or command error.
create/import starts a candidate; activate is a separate explicit action.
`;
const common = ['cwd', 'profile', 'data-dir', 'mode', 'connection', 'json', 'help'];
const snapshot = [
  'source',
  'base',
  'index-file',
  'source-commit',
  'base-commit',
  'target-branch',
  'path',
  'include-untracked',
  'exclude',
  'require-source',
  'require-knowledge',
];
const executor = ['executor-path', 'model', 'reasoning-effort'];
const allowed: Record<string, string[]> = {
  status: ['check-executor', ...executor],
  central: ['input', 'api-key-stdin', 'offline-behavior'],
  context: [...snapshot, 'offline', 'offline-behavior'],
  review: [
    'offline',
    'offline-behavior',
    'retry-finished',
    'trigger',
    ...snapshot,
    ...executor,
    'allow-path',
    'timeout-ms',
    'source-bytes',
    'tool-calls',
  ],
  'push-review': [
    'offline',
    'offline-behavior',
    'retry-finished',
    ...executor,
    'exclude',
    'require-source',
    'require-knowledge',
    'allow-path',
    'timeout-ms',
    'source-bytes',
    'tool-calls',
  ],
  service: [
    'trigger',
    ...executor,
    'exclude',
    'allow-path',
    'timeout-ms',
    'source-bytes',
    'tool-calls',
    'id',
  ],
  enqueue: [
    'trigger',
    'request-id',
    'source',
    'index-file',
    'source-commit',
    'base-commit',
    'target-branch',
    'path',
    'include-untracked',
  ],
  'enqueue-push': ['request-id'],
  requests: [],
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
const boolean = new Set([
  'json',
  'help',
  'check-executor',
  'api-key-stdin',
  'offline',
  'retry-finished',
]);
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
        ...(multiple.has(name) || (command === 'service' && name === 'trigger')
          ? { multiple: true }
          : {}),
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
