import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import type { ServerResult } from '../types.js';
import { fileProbeTool } from './chat-file-probe.js';
import { downloadChatFile, TransferError, validateSourceUrl, withAbort } from '../utils/chat-file-download.js';

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 45000;
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/);
const fileSchema = z.object({
    download_url: z.string().min(1).max(16384), file_id: z.string().min(1).max(16384),
    mime_type: z.string().max(1024).optional(), file_name: z.string().max(1024).optional(),
}).strict();
const importSchema = z.object({ file: fileSchema, destination_path: z.string().min(1).max(4096), transfer_id: idSchema }).strict();
const statusSchema = z.object({ transfer_id: idSchema }).strict();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const resultSchema = {
    type: 'object' as const,
    properties: {
        transfer_id: { type: 'string' }, status: { type: 'string', enum: ['saved', 'already_saved', 'in_progress', 'failed', 'unknown', 'needs_verification'] },
        computer_name: { type: 'string' }, destination_path: { type: 'string' },
        bytes: { type: 'integer' }, mime_type: { type: 'string' }, sha256: { type: 'string' }, code: { type: 'string' },
    }, required: ['transfer_id', 'status', 'computer_name'], additionalProperties: false,
};
export const importChatFileTool = {
    name: 'import_chat_file', title: 'Save an image from ChatGPT to this computer',
    description: 'Download a selected attachment or generated PNG/JPEG/WebP image from ChatGPT and save its original bytes on this computer. '
        + 'Pass the actual file, an absolute destination_path in an existing allowed directory, and a unique transfer_id (8-80 letters/digits/_/-). '
        + 'Never overwrite existing files. Maximum 25 MiB; 45-second deadline. Returns computer, path, byte count and SHA-256. '
        + 'After a lost response, call get_chat_file_transfer with the SAME transfer_id before doing anything else. '
        + 'Do not send base64, sandbox paths or invented download URLs/file IDs. inspect_chat_file_source only checks metadata and does not save.',
    inputSchema: { type: 'object' as const, properties: {
        file: fileProbeTool.inputSchema.properties.file,
        destination_path: { type: 'string' }, transfer_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$' },
    }, required: ['file', 'destination_path', 'transfer_id'], additionalProperties: false },
    outputSchema: resultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: { 'openai/fileParams': ['file'] },
} satisfies Tool;
export const getChatFileTransferTool = {
    name: 'get_chat_file_transfer', title: 'Check an image transfer without repeating it',
    description: 'Read the durable status of import_chat_file on this computer using its transfer_id. Checks the saved file against its SHA-256. '
        + 'Does not download, write, retry or delete anything. needs_verification means the result is uncertain; do not blindly repeat the import.',
    inputSchema: { type: 'object' as const, properties: { transfer_id: { type: 'string' } }, required: ['transfer_id'], additionalProperties: false },
    outputSchema: resultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
} satisfies Tool;

type Receipt = {
    transfer_id: string; status: 'in_progress' | 'prepared' | 'saved' | 'failed'; binding: string;
    destination_path: string; bytes?: number; mime_type?: string; sha256?: string; code?: string;
};
type Options = {
    stateDirectory: string; validatePath: (p: string) => Promise<string>;
    download?: typeof downloadChatFile; timeoutMs?: number; maxBytes?: number;
};
const response = (data: Record<string, unknown>): ServerResult => ({
    content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
});
const failure = (code: string): ServerResult => ({ isError: true, content: [{ type: 'text', text:
    `${code}: No successful import is confirmed. Check get_chat_file_transfer before retrying. `
    + 'For SOURCE_UNAVAILABLE, select the file again in ChatGPT to obtain a fresh link. Existing files are never overwritten.',
}] });

export function validateDestinationSyntax(p: string, platform = process.platform): void {
    if (!path.isAbsolute(p) || /[\x00-\x1f]/.test(p)) throw new TransferError('DESTINATION_NOT_ALLOWED');
    if (platform === 'win32') {
        if (!/^[A-Za-z]:[\\/]/.test(p) || /[:<>"|?*]/.test(p.slice(2))) throw new TransferError('DESTINATION_NOT_ALLOWED');
        for (const part of p.slice(3).split(/[\\/]/)) {
            if (!part || part === '.' || part === '..' || /[. ]$/.test(part) ||
                /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) throw new TransferError('DESTINATION_NOT_ALLOWED');
        }
    }
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(p).toLowerCase())) throw new TransferError('UNSUPPORTED_IMAGE');
}

/** Dependencies are explicit for isolated tests; tool arguments cannot change them. */
export function createChatFileImporter(options: Options) {
    const active = new Set<string>();
    let reserved = 0;
    const download = options.download ?? downloadChatFile;
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    const recordPath = (id: string) => path.join(options.stateDirectory, `${id}.json`);
    const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

    async function destination(p: string) {
        validateDestinationSyntax(p);
        const parent = await fs.realpath(path.dirname(p));
        const resolved = path.join(parent, path.basename(p));
        if (!same(await options.validatePath(resolved), resolved)) throw new TransferError('DESTINATION_CHANGED');
        const info = await fs.stat(parent);
        if (!info.isDirectory()) throw new TransferError('DESTINATION_NOT_ALLOWED');
        return { path: resolved, parent, dev: info.dev, ino: info.ino };
    }
    async function readReceipt(id: string): Promise<Receipt | undefined> {
        try { return JSON.parse(await fs.readFile(recordPath(id), 'utf8')); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new TransferError('RECEIPT_UNREADABLE'); }
    }
    async function persist(receipt: Receipt, first = false) {
        const target = recordPath(receipt.transfer_id);
        const temp = first ? target : `${target}.${randomUUID()}.tmp`;
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); }
        finally { await handle.close(); }
        if (!first) {
            try { await fs.rename(temp, target); }
            finally { await fs.unlink(temp).catch(() => {}); }
        }
    }
    async function verify(receipt: Receipt): Promise<boolean> {
        if (!receipt.sha256 || !receipt.bytes || receipt.bytes > maxBytes) return false;
        const dest = await destination(receipt.destination_path);
        const stat = await fs.lstat(dest.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== receipt.bytes) return false;
        const handle = await fs.open(dest.path, 'r');
        const digest = createHash('sha256');
        let bytes = 0;
        try {
            for await (const chunk of handle.createReadStream({ autoClose: false })) {
                bytes += chunk.length;
                if (bytes > maxBytes) return false;
                digest.update(chunk);
            }
            return bytes === receipt.bytes && digest.digest('hex') === receipt.sha256;
        } finally { await handle.close(); }
    }
    async function status(receipt: Receipt, repeat = false): Promise<ServerResult> {
        let state: string = receipt.status;
        if (state === 'saved' || state === 'prepared') {
            try { state = await verify(receipt) ? (repeat ? 'already_saved' : 'saved') : 'needs_verification'; }
            catch { state = 'needs_verification'; }
        } else if (state === 'in_progress' && !active.has(receipt.transfer_id)) state = 'needs_verification';
        const { binding: _binding, ...publicReceipt } = receipt;
        return response({ ...publicReceipt, status: state, computer_name: os.hostname() });
    }
    async function get(args: unknown): Promise<ServerResult> {
        const parsed = statusSchema.safeParse(args);
        if (!parsed.success) return failure('INVALID_TRANSFER_ID');
        try {
            const receipt = await readReceipt(parsed.data.transfer_id);
            return receipt ? await status(receipt) : response({ transfer_id: parsed.data.transfer_id, status: 'unknown', computer_name: os.hostname() });
        } catch { return response({ transfer_id: parsed.data.transfer_id, status: 'needs_verification', computer_name: os.hostname() }); }
    }
    async function save(args: unknown): Promise<ServerResult> {
        const parsed = importSchema.safeParse(args);
        if (!parsed.success) return failure('INVALID_FILE_DESCRIPTOR');
        const { file, destination_path, transfer_id } = parsed.data;
        let receipt: Receipt | undefined;
        let temporary: string | undefined;
        let published = false;
        let owns = false;
        let slot = false;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
        try {
            const dest = await destination(destination_path);
            const binding = hash(JSON.stringify([file.file_id, process.platform === 'win32' ? dest.path.toLowerCase() : dest.path]));
            const previous = await readReceipt(transfer_id);
            if (previous) {
                if (previous.binding !== binding) throw new TransferError('TRANSFER_ID_CONFLICT');
                return await status(previous, true);
            }
            validateSourceUrl(file.download_url);
            if (reserved >= 2) throw new TransferError('TRANSFER_BUSY');
            reserved++; slot = true;
            try { await fs.lstat(dest.path); throw new TransferError('DESTINATION_EXISTS'); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            await fs.mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
            receipt = { transfer_id, status: 'in_progress', binding, destination_path: dest.path };
            try { await persist(receipt, true); }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
                    const winner = await readReceipt(transfer_id);
                    if (!winner || winner.binding !== binding) throw new TransferError('TRANSFER_ID_CONFLICT');
                    return await status(winner, true);
                }
                throw e;
            }
            owns = true;
            active.add(transfer_id);
            temporary = path.join(dest.parent, `.codex-chat-import-${randomUUID()}.part`);
            const handle = await fs.open(temporary, 'wx', 0o600);
            let bytes = 0;
            const digest = createHash('sha256');
            try {
                await download(file.download_url, controller.signal, maxBytes, async chunk => {
                    controller.signal.throwIfAborted();
                    bytes += chunk.length;
                    if (bytes > maxBytes) throw new TransferError('FILE_TOO_LARGE');
                    digest.update(chunk);
                    await handle.writeFile(chunk);
                });
                await handle.sync();
            } finally { await handle.close(); }
            if (!bytes) throw new TransferError('INCOMPLETE_DOWNLOAD');
            // A bounded buffer prevents libvips' file cache retaining a Windows
            // handle to the temporary file after decoding has finished.
            const decoder = sharp(await fs.readFile(temporary), { failOn: 'warning', limitInputPixels: 64 * 1024 * 1024 });
            let pixels: ReturnType<typeof sharp> | undefined;
            let format: string | undefined;
            try {
                const meta = await withAbort(decoder.metadata(), controller.signal);
                format = meta.format;
                if (!['png', 'jpeg', 'webp'].includes(format ?? '') || (meta.pages ?? 1) > 1) throw new TransferError('UNSUPPORTED_IMAGE');
                // Decode for validation only; the original downloaded bytes are published.
                pixels = decoder.clone();
                await withAbort(pixels.stats(), controller.signal);
            } catch (e) { if (e instanceof TransferError) throw e; throw new TransferError('INVALID_IMAGE'); }
            finally { pixels?.destroy(); decoder.destroy(); }
            const extension = path.extname(dest.path).toLowerCase();
            if (!(format === 'png' ? ['.png'] : format === 'jpeg' ? ['.jpg', '.jpeg'] : ['.webp']).includes(extension)) {
                throw new TransferError('IMAGE_EXTENSION_MISMATCH');
            }
            receipt = { ...receipt, status: 'prepared', bytes, mime_type: `image/${format}`, sha256: digest.digest('hex') };
            await persist(receipt);
            controller.signal.throwIfAborted();
            const current = await destination(dest.path);
            if (!same(current.parent, dest.parent) || current.dev !== dest.dev || current.ino !== dest.ino) throw new TransferError('DESTINATION_CHANGED');
            // Hard-link publication is atomic and fails if ANY destination exists.
            // Unlike rename(), it never replaces a user's file on Windows or POSIX.
            await fs.link(temporary, dest.path);
            published = true;
            receipt.status = 'saved';
            await persist(receipt);
            return await status(receipt);
        } catch (e) {
            const code = controller.signal.aborted ? 'TRANSFER_TIMEOUT' : e instanceof TransferError ? e.code :
                (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'DESTINATION_EXISTS' : 'TRANSFER_FAILED';
            if (owns && receipt && !published) {
                receipt.status = 'failed'; receipt.code = code;
                await persist(receipt).catch(() => {});
            }
            return failure(published ? 'VERIFY_SAVED_FILE' : code);
        } finally {
            clearTimeout(timer);
            if (owns) active.delete(transfer_id);
            if (slot) reserved--;
            if (temporary) await fs.unlink(temporary).catch(() => {});
        }
    }
    return { save, get };
}

let importer: Promise<ReturnType<typeof createChatFileImporter>> | undefined;
function instance() {
    if (!importer) {
        importer = import('./filesystem.js').then(({ validatePath }) => createChatFileImporter({
            stateDirectory: path.join(os.homedir(), '.claude-server-commander', 'chat-file-transfers'), validatePath,
        }));
    }
    return importer;
}
export async function importChatFile(args: unknown) { return (await instance()).save(args); }
export async function getChatFileTransfer(args: unknown) { return (await instance()).get(args); }
