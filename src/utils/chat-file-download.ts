import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export type TransferDiagnostics = {
    stage?: string; reason?: string; http_status?: number; redirect_count?: number;
};
export type DownloadProgress = {
    stage: string; source_host?: string; redirect_count?: number; bytes_received?: number; source_route?: 'public' | 'openwrt_fakeip';
};
type Progress = (update: DownloadProgress) => void;

// Never pass URL credentials, signed paths or queries to the public result.
function safeHost(url?: URL): string | undefined {
    const host = url?.hostname;
    return host && host.length <= 253 && /^[a-z0-9.-]+$/.test(host) ? host : undefined;
}

export class TransferError extends Error {
    public readonly sourceHost?: string;
    constructor(public readonly code: string, sourceUrl?: URL, public readonly diagnostics: TransferDiagnostics = {}) {
        super(code);
        this.sourceHost = safeHost(sourceUrl);
    }
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

export type DownloadPolicy = Readonly<{ allowOpenWrtFakeIp?: boolean }>;

// Only these exact accounts are trusted; unrelated tenants share blob.core.windows.net.
const azureSourceHosts = new Set([
    'oaisdmntprdenmarkeast.blob.core.windows.net',
    'oaisdmntprnortheu.blob.core.windows.net',
    'oaisdmntprindiasocentral.blob.core.windows.net',
    'oaisdmntprcentralus.blob.core.windows.net',
    'oaisdmntprukwest.blob.core.windows.net',
    'oaisdmntprpolandcentral.blob.core.windows.net',
]);

function isFakeIpSourceHost(hostname: string): boolean {
    return azureSourceHosts.has(hostname) || /^sdmntpr[a-z0-9-]{0,56}\.oaiusercontent\.com$/.test(hostname);
}

function isOpenWrtFakeIp(address: string, family: number): boolean {
    return family === 4 && isIP(address) === 4 &&
        (address.startsWith('198.18.') || address.startsWith('198.19.'));
}

export function validateSourceUrl(value: string, stage = 'source_url_validation', redirect_count = 0): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new TransferError('SOURCE_NOT_ALLOWED', undefined, { stage, reason: 'MALFORMED_URL', redirect_count }); }
    const reject = (reason: string): never => { throw new TransferError('SOURCE_NOT_ALLOWED', url, { stage, reason, redirect_count }); };
    const allowedHost = url.hostname.endsWith('.oaiusercontent.com') || azureSourceHosts.has(url.hostname);
    if (url.protocol !== 'https:') reject('HTTPS_REQUIRED');
    if (url.username || url.password) reject('URL_CREDENTIALS_FORBIDDEN');
    if (url.hash) reject('URL_FRAGMENT_FORBIDDEN');
    if (url.port && url.port !== '443') reject('NONSTANDARD_HTTPS_PORT');
    if (!/^[a-z0-9.-]+$/.test(url.hostname)) reject('INVALID_HOSTNAME');
    if (!allowedHost) reject('HOST_NOT_ALLOWLISTED');
    return url;
}

export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        // Callers may already have started native work (e.g. Sharp metadata).
        // Observe its eventual rejection even though the timeout is returned now.
        void work.catch(() => {});
        return Promise.reject(new TransferError('TRANSFER_TIMEOUT'));
    }
    return new Promise((resolve, reject) => {
        const abort = () => reject(new TransferError('TRANSFER_TIMEOUT'));
        signal.addEventListener('abort', abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

function stageError(code: string, reason: string, stage: string, url: URL, redirect_count: number, http_status?: number) {
    return new TransferError(code, url, { stage, reason, redirect_count,
        ...(http_status !== undefined && http_status >= 100 && http_status <= 599 ? { http_status } : {}) });
}

async function requestFile(url: URL, signal: AbortSignal, redirects: number, allowOpenWrtFakeIp: boolean, progress?: Progress): Promise<IncomingMessage> {
    const source_host = safeHost(url);
    progress?.({ stage: 'dns_lookup', source_host, redirect_count: redirects });
    const timeout = (stage: string) => stageError('TRANSFER_TIMEOUT', 'DEADLINE_EXCEEDED', stage, url, redirects);
    if (signal.aborted) throw timeout('dns_lookup');
    const addresses = await withAbort(dns.lookup(url.hostname, { all: true, verbatim: true }), signal).catch(() => {
        if (signal.aborted) throw timeout('dns_lookup');
        throw stageError('TRANSFER_FAILED', 'DNS_LOOKUP_FAILED', 'dns_lookup', url, redirects);
    });
    if (!addresses.length) throw stageError('SOURCE_NOT_ALLOWED', 'DNS_NO_ADDRESSES', 'dns_lookup', url, redirects);
    // Check the whole answer set anew on each hop; reject mixed public/fake/private routes.
    const trustedFakeRoute = allowOpenWrtFakeIp && isFakeIpSourceHost(url.hostname) &&
        addresses.every(({ address, family }) => isOpenWrtFakeIp(address, family));
    if (!trustedFakeRoute && !addresses.every(({ address, family }) => isIP(address) === family && isPublicAddress(address))) {
        throw stageError('SOURCE_NOT_ALLOWED', 'NON_PUBLIC_ADDRESS', 'dns_lookup', url, redirects);
    }
    const selected = addresses.find(a => a.family === 4) ?? addresses[0];
    progress?.({ stage: 'http_request', source_host, redirect_count: redirects, source_route: trustedFakeRoute ? 'openwrt_fakeip' : 'public' });
    try {
        return await new Promise<IncomingMessage>((resolve, reject) => {
            // Pin the validated DNS answer while retaining the original TLS hostname.
            const request = https.get(url, {
                agent: false, signal, family: selected.family,
                ...(trustedFakeRoute ? { servername: url.hostname, rejectUnauthorized: true } : {}),
                lookup: (_hostname, options, callback) => {
                    if (typeof options === 'object' && options.all) callback(null, [selected] as any);
                    else callback(null, selected.address, selected.family);
                },
                headers: { Accept: 'image/png, image/jpeg, image/webp', 'Accept-Encoding': 'identity' },
            }, resolve);
            request.on('error', reject);
        });
    } catch {
        if (signal.aborted) throw timeout('http_request');
        throw stageError('DOWNLOAD_FAILED', 'HTTPS_REQUEST_FAILED', 'http_request', url, redirects);
    }
}

/** Consume the body under the same deadline as DNS, redirects and headers. */
export async function downloadChatFile(
    source: string, signal: AbortSignal, maxBytes: number,
    consume: (chunk: Buffer) => Promise<void>, progress?: Progress, policy?: DownloadPolicy,
): Promise<void> {
    progress?.({ stage: 'source_url_validation', redirect_count: 0 });
    let url = validateSourceUrl(source);
    for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await requestFile(url, signal, redirects, policy?.allowOpenWrtFakeIp === true, progress);
        const status = response.statusCode;
        const source_host = safeHost(url);
        progress?.({ stage: 'http_response', source_host, redirect_count: redirects });
        const responseError = (code: string, reason: string) => stageError(code, reason, 'http_response', url, redirects, status);
        if ([301, 302, 303, 307, 308].includes(status ?? 0)) {
            const location = response.headers.location;
            response.destroy();
            if (!location) throw responseError('DOWNLOAD_FAILED', 'REDIRECT_WITHOUT_LOCATION');
            if (redirects === 3) throw responseError('DOWNLOAD_FAILED', 'REDIRECT_LIMIT_EXCEEDED');
            progress?.({ stage: 'redirect_validation', redirect_count: redirects + 1 });
            let target: URL;
            try { target = new URL(location, url); }
            catch { throw new TransferError('SOURCE_NOT_ALLOWED', undefined,
                { stage: 'redirect_validation', reason: 'MALFORMED_URL', redirect_count: redirects + 1, http_status: status }); }
            url = validateSourceUrl(target.href, 'redirect_validation', redirects + 1);
            continue;
        }
        if (status !== 200) {
            response.destroy();
            throw responseError([401, 403, 404, 410].includes(status ?? 0) ? 'SOURCE_UNAVAILABLE' : 'DOWNLOAD_FAILED', 'HTTP_STATUS');
        }
        const length = response.headers['content-length'];
        let bytes = 0;
        const reportBody = () => progress?.({ stage: 'response_body', source_host, redirect_count: redirects, bytes_received: bytes });
        const bodyError = (code: string, reason: string) => stageError(code, reason, 'response_body', url, redirects, status);
        try {
            if (length !== undefined && !/^\d+$/.test(length)) throw responseError('INVALID_SIZE_OR_ENCODING', 'INVALID_CONTENT_LENGTH');
            if (length !== undefined && Number(length) > maxBytes) throw responseError('INVALID_SIZE_OR_ENCODING', 'DECLARED_SIZE_EXCEEDED');
            if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                throw responseError('INVALID_SIZE_OR_ENCODING', 'CONTENT_ENCODING_NOT_IDENTITY');
            }
            // Keep disk/consumer errors distinct from stream read errors.
            const stream = response[Symbol.asyncIterator]();
            while (true) {
                reportBody();
                if (signal.aborted) throw bodyError('TRANSFER_TIMEOUT', 'DEADLINE_EXCEEDED');
                const item = await stream.next().catch(() => {
                    if (signal.aborted) throw bodyError('TRANSFER_TIMEOUT', 'DEADLINE_EXCEEDED');
                    throw bodyError('TRANSFER_FAILED', 'RESPONSE_BODY_READ_FAILED');
                });
                if (signal.aborted) throw bodyError('TRANSFER_TIMEOUT', 'DEADLINE_EXCEEDED');
                if (item.done) break;
                const chunk = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value);
                bytes += chunk.length;
                reportBody();
                if (bytes > maxBytes) throw bodyError('FILE_TOO_LARGE', 'STREAM_SIZE_EXCEEDED');
                await consume(chunk);
            }
            if (!bytes) throw bodyError('INCOMPLETE_DOWNLOAD', 'EMPTY_BODY');
            if (length !== undefined && bytes !== Number(length)) throw bodyError('INCOMPLETE_DOWNLOAD', 'INCOMPLETE_BODY');
            return;
        } finally { response.destroy(); }
    }
}
