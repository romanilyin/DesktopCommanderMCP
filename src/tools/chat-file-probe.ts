import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ServerResult } from '../types.js';

/** A file-input compatibility check. Deliberately performs no I/O. */
export const fileProbeTool = {
    name: 'inspect_chat_file_source',
    title: 'Check ChatGPT file handoff (does not save)',
    description: 'Check whether ChatGPT can pass a selected attachment or generated image to this computer. '
        + 'Pass the actual file using the file parameter. Reports field presence and the HTTPS source host only. '
        + 'Does not download, save, modify, or execute the file. Do not manufacture a file ID or download URL. '
        + 'This is a compatibility check. To save the image, use import_chat_file instead.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            file: {
                type: 'object',
                properties: {
                    download_url: { type: 'string' }, file_id: { type: 'string' },
                    mime_type: { type: 'string' }, file_name: { type: 'string' },
                },
                required: ['download_url', 'file_id'],
                additionalProperties: false,
            },
        },
        required: ['file'], additionalProperties: false,
    },
    outputSchema: {
        type: 'object' as const,
        properties: {
            stage: { type: 'string', const: 'metadata_only' },
            fields_present: {
                type: 'object',
                properties: {
                    download_url: { type: 'boolean', const: true },
                    file_id: { type: 'boolean', const: true },
                    mime_type: { type: 'boolean' }, file_name: { type: 'boolean' },
                },
                required: ['download_url', 'file_id', 'mime_type', 'file_name'],
                additionalProperties: false,
            },
            source_host: { type: 'string' }, standard_https_port: { type: 'boolean' },
            declared_image_type: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'unverified'] },
            download_checked: { type: 'boolean', const: false },
            file_saved: { type: 'boolean', const: false },
        },
        required: ['stage', 'fields_present', 'source_host', 'standard_https_port', 'declared_image_type', 'download_checked', 'file_saved'],
        additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { 'openai/fileParams': ['file'] },
} satisfies Tool;

const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const errorResult = (): ServerResult => ({
    isError: true,
    content: [{ type: 'text', text: 'INVALID_FILE_DESCRIPTOR: select a file in ChatGPT. '
        + 'The file must contain nonempty download_url and file_id strings; file_name and mime_type are optional strings. '
        + 'Only an HTTPS URL without embedded credentials is accepted. Nothing was downloaded or saved.' }],
});

export function inspectFileDescriptor(args: unknown): ServerResult {
    try {
        if (!object(args) || Object.keys(args).some(key => key !== 'file') || !object(args.file)) return errorResult();
        const f = args.file;
        if (Object.keys(f).some(key => !hasOwn(fileProbeTool.inputSchema.properties.file.properties, key))) return errorResult();
        for (const key of ['download_url', 'file_id']) {
            const value = f[key];
            if (typeof value !== 'string' || value.trim().length === 0 || value.length > 16384) return errorResult();
        }
        for (const key of ['file_name', 'mime_type']) {
            if (hasOwn(f, key) && (typeof f[key] !== 'string' || f[key].length > 1024)) return errorResult();
        }
        const url = new URL(f.download_url as string);
        if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hostname.length > 253) return errorResult();
        // Host only; never emit signed URL components, file IDs or source names.
        const observation = {
            stage: 'metadata_only',
            fields_present: {
                download_url: true, file_id: true,
                mime_type: hasOwn(f, 'mime_type'), file_name: hasOwn(f, 'file_name'),
            },
            source_host: url.hostname,
            standard_https_port: !url.port || url.port === '443',
            declared_image_type: ['image/png', 'image/jpeg', 'image/webp'].includes(f.mime_type as string) ? f.mime_type : 'unverified',
            download_checked: false, file_saved: false,
        };
        return { content: [{ type: 'text', text: JSON.stringify(observation) }], structuredContent: observation };
    } catch {
        return errorResult();
    }
}
