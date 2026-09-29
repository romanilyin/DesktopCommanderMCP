/** Keep file-param tool arguments out of persistent logs and tool history. */
export function sanitizeToolArguments(toolName: string, args: unknown): unknown {
  if (toolName !== 'import_chat_file' && toolName !== 'inspect_chat_file_source') {
    return args;
  }

  // Inspect only own-key presence. Never read or serialize a value: the file
  // object can carry a temporary download URL, IDs, names, or arbitrary data.
  const fields = toolName === 'import_chat_file'
    ? ['file', 'destination_path', 'transfer_id'] as const
    : ['file'] as const;
  const result: Record<string, 'present' | 'absent' | 'unknown'> = {};
  for (const field of fields) {
    try {
      result[field] = args !== null && typeof args === 'object' && Object.prototype.hasOwnProperty.call(args, field)
        ? 'present' : 'absent';
    } catch {
      // A malformed Proxy can throw from hasOwnProperty. Do not record its
      // exception text because it may contain a credential or URL.
      result[field] = 'unknown';
    }
  }
  return { redacted: true, fields: result };
}
