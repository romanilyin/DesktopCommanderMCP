import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export class TransferError extends Error {
    constructor(public readonly code: string) { super(code); }
}

const blocked = new BlockList();
for (const [ip, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
    blocked.addSubnet(ip, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
    const version = isIP(address);
    if (version === 4) return !blocked.check(address, 'ipv4');
    return version === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function validateSourceUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new TransferError('SOURCE_NOT_ALLOWED'); }
    // Both hosts were observed in real file-param handoffs: Codex used the CDN,
    // web ChatGPT used this exact Azure storage account. Do not allow all Azure
    // tenants; unrelated accounts share blob.core.windows.net.
    const allowedHost = url.hostname.endsWith('.oaiusercontent.com') ||
        url.hostname === 'oaisdmntprdenmarkeast.blob.core.windows.net';
    if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
        (url.port && url.port !== '443') || !allowedHost ||
        !/^[a-z0-9.-]+$/.test(url.hostname)) throw new TransferError('SOURCE_NOT_ALLOWED');
    return url;
}

export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new TransferError('TRANSFER_TIMEOUT'));
    return new Promise((resolve, reject) => {
        const abort = () => reject(new TransferError('TRANSFER_TIMEOUT'));
        signal.addEventListener('abort', abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

async function requestFile(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
    const addresses = await withAbort(dns.lookup(url.hostname, { all: true, verbatim: true }), signal);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new TransferError('SOURCE_NOT_ALLOWED');
    }
    const selected = addresses.find(a => a.family === 4) ?? addresses[0];
    return new Promise((resolve, reject) => {
        // Pin the validated DNS answer while retaining the original TLS hostname.
        const request = https.get(url, {
            agent: false, signal, family: selected.family,
            lookup: (_hostname, options, callback) => {
                if (typeof options === 'object' && options.all) callback(null, [selected] as any);
                else callback(null, selected.address, selected.family);
            },
            headers: { Accept: 'image/png, image/jpeg, image/webp', 'Accept-Encoding': 'identity' },
        }, resolve);
        request.on('error', () => reject(new TransferError(signal.aborted ? 'TRANSFER_TIMEOUT' : 'DOWNLOAD_FAILED')));
    });
}

/** Consume the body under the same deadline as DNS, redirects and headers. */
export async function downloadChatFile(
    source: string, signal: AbortSignal, maxBytes: number,
    consume: (chunk: Buffer) => Promise<void>,
): Promise<void> {
    let url = validateSourceUrl(source);
    for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await requestFile(url, signal);
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;
            response.destroy();
            if (!location || redirects === 3) throw new TransferError('DOWNLOAD_FAILED');
            try { url = validateSourceUrl(new URL(location, url).href); }
            catch { throw new TransferError('SOURCE_NOT_ALLOWED'); }
            continue;
        }
        if (status !== 200) {
            response.destroy();
            throw new TransferError([401, 403, 404, 410].includes(status) ? 'SOURCE_UNAVAILABLE' : 'DOWNLOAD_FAILED');
        }
        const length = response.headers['content-length'];
        if ((length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) ||
            (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            response.destroy();
            throw new TransferError('INVALID_SIZE_OR_ENCODING');
        }
        let bytes = 0;
        try {
            for await (const raw of response) {
                signal.throwIfAborted();
                const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                bytes += chunk.length;
                if (bytes > maxBytes) throw new TransferError('FILE_TOO_LARGE');
                await consume(chunk);
            }
            if (!bytes || (length !== undefined && bytes !== Number(length))) throw new TransferError('INCOMPLETE_DOWNLOAD');
            return;
        } finally { response.destroy(); }
    }
}
