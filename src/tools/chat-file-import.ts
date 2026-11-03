import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import type { ServerResult } from '../types.js';
import { BUILD_REVISION } from '../utils/build-revision.js';
import { diagnostic, reply, resultSchema, type ChatTool, type FailureFacts, type Status } from './chat-file-result.js';
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
export const importChatFileTool = {
    name: 'import_chat_file', title: 'Save an image from ChatGPT to this computer',
    description: 'Download a selected attachment or generated PNG/JPEG/WebP image from ChatGPT and save its original bytes on this computer. '
        + 'Pass the actual file, an absolute destination_path in an existing allowed directory, and a unique transfer_id (8-80 letters/digits/_/-). '
        + 'Never overwrite existing files. Maximum 25 MiB; 45-second deadline. Returns computer, path, byte count and SHA-256. '
        + 'Errors return a stage, reason, save_outcome and next_action. Report a failed import with its exact error, transfer ID and host when available. '
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

const safeHost = (host?: string) => host && host.length <= 253 && /^[a-z0-9.-]+$/.test(host) ? host : undefined;
const diagnosticCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const count = z.number().int().nonnegative();
const receiptSchema = z.object({
    transfer_id: idSchema, status: z.enum(['in_progress', 'prepared', 'saved', 'failed']),
    binding: z.string().regex(/^[0-9a-f]{64}$/), destination_path: z.string().min(1).max(4096),
    bytes: count.optional(), mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), code: diagnosticCode.optional(),
    reason: diagnosticCode.optional(), stage: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    source_host: z.string().max(253).regex(/^[a-z0-9.-]+$/).optional(),
    http_status: count.max(999).optional(), redirect_count: count.optional(), elapsed_ms: count.optional(),
    bytes_received: count.optional(), timeout_ms: count.optional(),
    failure_build_revision: z.string().regex(/^(unknown|[0-9a-f]{7,64}(-dirty)?)$/).optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
type Options = {
    stateDirectory: string; validatePath: (p: string) => Promise<string>;
    download?: typeof downloadChatFile; timeoutMs?: number; maxBytes?: number;
};
function validatedId(args: unknown): string | undefined {
    if (typeof args !== 'object' || args === null || !('transfer_id' in args)) return undefined;
    const id = idSchema.safeParse(args.transfer_id);
    return id.success ? id.data : undefined;
}

function errorFacts(error: unknown, stage: string, timedOut: boolean): FailureFacts {
    const typed = error instanceof TransferError ? error : undefined;
    const errno = (error as NodeJS.ErrnoException | null)?.code;
    const code = timedOut ? 'TRANSFER_TIMEOUT' : typed?.code ?? (errno === 'EEXIST' ? 'DESTINATION_EXISTS' : 'TRANSFER_FAILED');
    const reason = timedOut ? 'DEADLINE_EXCEEDED' : typed?.diagnostics.reason ??
        (errno === 'ENOSPC' ? 'DISK_FULL' : errno === 'EACCES' || errno === 'EPERM'
            ? (/^receipt_(create|prepare|finalize)$|^temporary_write$|^publish$/.test(stage) ? 'WRITE_DENIED' : 'ACCESS_DENIED')
            : (errno === 'ENOENT' || errno === 'ENOTDIR') && stage === 'destination_validation' ? 'PARENT_NOT_FOUND' : code);
    return { code, reason, stage: typed?.diagnostics.stage ?? stage,
        ...(typed?.sourceHost ? { source_host: typed.sourceHost } : {}),
        ...(typed?.diagnostics.http_status !== undefined ? { http_status: typed.diagnostics.http_status } : {}),
        ...(typed?.diagnostics.redirect_count !== undefined ? { redirect_count: typed.diagnostics.redirect_count } : {}) };
}

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
        let authorized: string;
        try { authorized = await options.validatePath(resolved); }
        catch { throw new TransferError('DESTINATION_NOT_ALLOWED'); }
        if (!same(authorized, resolved)) throw new TransferError('DESTINATION_CHANGED');
        const info = await fs.stat(parent);
        if (!info.isDirectory()) throw new TransferError('DESTINATION_NOT_ALLOWED');
        return { path: resolved, parent, dev: info.dev, ino: info.ino };
    }
    async function readReceipt(id: string): Promise<Receipt | undefined> {
        try {
            const receipt = receiptSchema.parse(JSON.parse(await fs.readFile(recordPath(id), 'utf8')));
            if (receipt.transfer_id !== id) throw new TransferError('RECEIPT_UNREADABLE');
            return receipt;
        }
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
    async function status(receipt: Receipt, tool: ChatTool, repeat = false, publishedByCall = false): Promise<ServerResult> {
        let state: Status;
        if (receipt.status === 'saved' || receipt.status === 'prepared') {
            try { state = await verify(receipt) ? (repeat ? 'already_saved' : 'saved') : 'needs_verification'; }
            catch { state = 'needs_verification'; }
        } else if (receipt.status === 'in_progress' && !active.has(receipt.transfer_id)) state = 'needs_verification';
        else state = receipt.status;
        if (state === 'failed') {
            const { code = 'TRANSFER_FAILED', reason = code, stage = 'previous_attempt', source_host,
                http_status, redirect_count, bytes_received, elapsed_ms, timeout_ms, failure_build_revision } = receipt;
            return diagnostic(tool, receipt.transfer_id, state, 'not_saved_by_this_call',
                { code, reason, stage, source_host, http_status, redirect_count, bytes_received, elapsed_ms, timeout_ms, failure_build_revision },
                { isError: tool === 'import_chat_file', replay: repeat, destination_path: receipt.destination_path });
        }
        if (state === 'needs_verification') {
            return diagnostic(tool, receipt.transfer_id, state, publishedByCall ? 'published_unverified' : 'unconfirmed',
                { code: 'VERIFY_SAVED_FILE', stage: 'receipt_verification',
                    reason: receipt.status === 'in_progress' ? 'INTERRUPTED_TRANSFER' : 'FILE_VERIFICATION_FAILED' },
                { isError: tool === 'import_chat_file', destination_path: receipt.destination_path });
        }
        const { transfer_id, destination_path, bytes, mime_type, sha256 } = receipt;
        return reply(tool, { transfer_id, status: state, destination_path, bytes, mime_type, sha256 });
    }
    async function get(args: unknown): Promise<ServerResult> {
        const tool = 'get_chat_file_transfer';
        const parsed = statusSchema.safeParse(args);
        if (!parsed.success) return diagnostic(tool, validatedId(args), 'unknown', 'not_saved_by_this_call',
            { code: 'INVALID_TRANSFER_ID', stage: 'input_validation', reason: 'INVALID_TRANSFER_ID' });
        const id = parsed.data.transfer_id;
        try {
            const receipt = await readReceipt(id);
            return receipt ? await status(receipt, tool) : reply(tool, { transfer_id: id, status: 'unknown',
                stage: 'receipt_lookup', reason: 'NO_RECEIPT_FOUND', save_outcome: 'unconfirmed',
                next_action: 'verify_destination_if_response_was_lost' });
        } catch {
            return diagnostic(tool, id, 'needs_verification', 'unconfirmed',
                { code: 'RECEIPT_UNREADABLE', stage: 'receipt_lookup', reason: 'RECEIPT_UNREADABLE' });
        }
    }
    async function save(args: unknown): Promise<ServerResult> {
        const tool = 'import_chat_file';
        const parsed = importSchema.safeParse(args);
        if (!parsed.success) {
            const id = validatedId(args);
            const reason = !id ? 'INVALID_TRANSFER_ID' : parsed.error.issues.some(i => i.path[0] === 'destination_path')
                ? 'INVALID_DESTINATION_PATH' : 'INVALID_FILE_DESCRIPTOR';
            return diagnostic(tool, id, 'unknown', 'not_saved_by_this_call',
                { code: 'INVALID_FILE_DESCRIPTOR', stage: 'input_validation', reason });
        }
        const { file, destination_path, transfer_id } = parsed.data;
        let receipt: Receipt | undefined;
        let temporary: string | undefined;
        let published = false;
        let owns = false;
        let slot = false;
        const controller = new AbortController();
        const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
        const started = performance.now();
        let stage = 'destination_validation';
        let host: string | undefined;
        let redirectCount: number | undefined;
        let received: number | undefined;
        let firstPersistAttempted = false;
        let atDeadline: { stage: string; bytes?: number; host?: string; redirects?: number } | undefined;
        const timer = setTimeout(() => {
            atDeadline = { stage, bytes: received, host, redirects: redirectCount };
            controller.abort();
        }, timeoutMs);
        try {
            const dest = await destination(destination_path);
            const binding = hash(JSON.stringify([file.file_id, process.platform === 'win32' ? dest.path.toLowerCase() : dest.path]));
            stage = 'receipt_lookup';
            const previous = await readReceipt(transfer_id);
            if (previous) {
                if (previous.binding !== binding) throw new TransferError('TRANSFER_ID_CONFLICT');
                return await status(previous, tool, true);
            }
            stage = 'source_url_validation';
            host = safeHost(validateSourceUrl(file.download_url).hostname);
            stage = 'reserve_slot';
            if (reserved >= 2) throw new TransferError('TRANSFER_BUSY');
            reserved++; slot = true;
            stage = 'destination_check';
            try { await fs.lstat(dest.path); throw new TransferError('DESTINATION_EXISTS'); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            stage = 'receipt_create';
            await fs.mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
            receipt = { transfer_id, status: 'in_progress', binding, destination_path: dest.path };
            firstPersistAttempted = true;
            try { await persist(receipt, true); }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
                    const winner = await readReceipt(transfer_id);
                    if (!winner || winner.binding !== binding) throw new TransferError('TRANSFER_ID_CONFLICT');
                    return await status(winner, tool, true);
                }
                throw e;
            }
            owns = true;
            active.add(transfer_id);
            temporary = path.join(dest.parent, `.codex-chat-import-${randomUUID()}.part`);
            stage = 'temporary_write';
            const handle = await fs.open(temporary, 'wx', 0o600);
            let bytes = 0;
            const digest = createHash('sha256');
            try {
                stage = 'download';
                received = 0;
                await download(file.download_url, controller.signal, maxBytes, async chunk => {
                    controller.signal.throwIfAborted();
                    bytes += chunk.length;
                    received = bytes;
                    stage = 'response_body';
                    if (bytes > maxBytes) throw new TransferError('FILE_TOO_LARGE');
                    digest.update(chunk);
                    stage = 'temporary_write';
                    await handle.writeFile(chunk);
                    stage = 'response_body';
                }, progress => {
                    stage = progress.stage;
                    host = safeHost(progress.source_host);
                    if (progress.redirect_count !== undefined) redirectCount = progress.redirect_count;
                    if (progress.bytes_received !== undefined) received = progress.bytes_received;
                });
                stage = 'temporary_write';
                await handle.sync();
            } finally { await handle.close(); }
            stage = 'response_body';
            if (!bytes) throw new TransferError('INCOMPLETE_DOWNLOAD');
            stage = 'image_validation';
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
            receipt = { ...receipt, status: 'prepared', bytes, mime_type: format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp', sha256: digest.digest('hex') };
            stage = 'receipt_prepare';
            await persist(receipt);
            controller.signal.throwIfAborted();
            stage = 'destination_revalidation';
            const current = await destination(dest.path);
            if (!same(current.parent, dest.parent) || current.dev !== dest.dev || current.ino !== dest.ino) throw new TransferError('DESTINATION_CHANGED');
            // Hard-link publication is atomic and fails if ANY destination exists.
            // Unlike rename(), it never replaces a user's file on Windows or POSIX.
            controller.signal.throwIfAborted();
            stage = 'publish';
            await fs.link(temporary, dest.path);
            published = true;
            stage = 'receipt_finalize';
            receipt.status = 'saved';
            await persist(receipt);
            return await status(receipt, tool, false, true);
        } catch (e) {
            // An unrelated error observed near the deadline must retain its actual cause.
            const timedOut = (controller.signal.aborted && (e === controller.signal.reason || (e as Error | null)?.name === 'AbortError'))
                || (e instanceof TransferError && e.code === 'TRANSFER_TIMEOUT');
            const facts = errorFacts(e, stage, timedOut);
            if (timedOut && atDeadline) facts.stage = atDeadline.stage;
            const observedHost = timedOut && atDeadline ? atDeadline.host : host;
            if (!facts.source_host && observedHost && facts.stage !== 'redirect_validation' && facts.stage !== 'source_url_validation') {
                facts.source_host = observedHost;
            }
            const count = timedOut && atDeadline ? atDeadline.redirects : redirectCount;
            if (facts.redirect_count === undefined && count !== undefined) facts.redirect_count = count;
            const bytes = timedOut && atDeadline ? atDeadline.bytes : received;
            if (bytes !== undefined) facts.bytes_received = bytes;
            facts.elapsed_ms = Math.round(performance.now() - started);
            if (timedOut) facts.timeout_ms = timeoutMs;
            facts.failure_build_revision = BUILD_REVISION;
            let state: Status = 'unknown';
            if (published) {
                // Keep the prepared receipt for SHA-256 recovery; never record failure after publication.
                facts.code = 'VERIFY_SAVED_FILE';
                state = 'needs_verification';
            } else if (owns && receipt) {
                Object.assign(receipt, facts, { status: 'failed' });
                try { await persist(receipt); state = 'failed'; }
                catch { state = 'needs_verification'; } // no durable failed receipt was confirmed
            } else if ((stage === 'receipt_create' && firstPersistAttempted && facts.code !== 'TRANSFER_ID_CONFLICT') ||
                facts.code === 'RECEIPT_UNREADABLE') state = 'needs_verification';
            return diagnostic(tool, transfer_id, state, published ? 'published_unverified' : 'not_saved_by_this_call', facts);
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
