/** Process-local ports; these are not serialized grants or model-supplied instructions. */
export type FixedSourceToolName = 'list_files' | 'read_file' | 'search_code';
export interface FixedSourceToolPort {
  execute(name: FixedSourceToolName, argumentsValue: unknown): Promise<string>;
}
export interface SourceReadReceipt {
  sequence: number;
  tool: FixedSourceToolName;
  argumentsHash: string;
  responseHash: string;
  responseBytes: number;
}
