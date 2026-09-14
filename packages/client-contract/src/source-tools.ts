/** Shared declarations for the fixed-source port; they grant no filesystem access. */
export const fixedSourceTools = [
  {
    name: 'list_files',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'List up to 100 authorized files from the immutable source/base snapshot. Follow nextOffset for more files. This is not the live repository.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, maximum: 10000 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Read numbered lines from an authorized fixed source or base file, with its SHA-256. Maximum 200 lines per read. Check truncation; a location is not defect evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        side: { type: 'string', enum: ['source', 'base'] },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_code',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Search literal text only within authorized fixed files. Returns at most 100 matches, not a semantic call graph or proof of absence outside this scope.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 300 },
        side: { type: 'string', enum: ['source', 'base'] },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
] as const;
