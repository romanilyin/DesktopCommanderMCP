import os from 'node:os';
import type { ServerResult } from '../types.js';
import { BUILD_REVISION } from '../utils/build-revision.js';

export type ChatTool = 'import_chat_file' | 'get_chat_file_transfer';
export type Status = 'saved' | 'already_saved' | 'in_progress' | 'failed' | 'unknown' | 'needs_verification';
export type SaveOutcome = 'not_saved_by_this_call' | 'published_unverified' | 'unconfirmed';
export type FailureFacts = {
    code: string; stage: string; reason: string; source_host?: string; http_status?: number;
    redirect_count?: number; bytes_received?: number; elapsed_ms?: number; timeout_ms?: number;
    failure_build_revision?: string;
};

const string = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
export const resultSchema = {
    type: 'object' as const, additionalProperties: false,
    properties: {
        transfer_id: string, status: { type: 'string', enum: ['saved', 'already_saved', 'in_progress', 'failed', 'unknown', 'needs_verification'] },
        tool: { type: 'string', enum: ['import_chat_file', 'get_chat_file_transfer'] },
        computer_name: string, build_revision: string, failure_build_revision: string, destination_path: string,
        bytes: integer, mime_type: string, sha256: string, code: string, stage: string, reason: string,
        source_route: { type: 'string', enum: ['public', 'openwrt_fakeip'] },
        source_host: string, http_status: integer, redirect_count: integer, bytes_received: integer,
        elapsed_ms: integer, timeout_ms: integer, save_outcome: string, next_action: string, retry_policy: string,
    },
    // A syntactically invalid ID must never be echoed (or replaced with an invented ID).
    required: ['status', 'tool', 'computer_name', 'build_revision'],
};

// All descriptions are local constants. Never format a URL, native Error.message, stack, or request headers.
const explanations: Record<string, string> = {
    HOST_NOT_ALLOWLISTED: 'The host is not in this build’s permitted source list.',
    MALFORMED_URL: 'The supplied source URL could not be parsed.',
    HTTPS_REQUIRED: 'The source must use HTTPS.',
    URL_CREDENTIALS_FORBIDDEN: 'The source URL contains credentials.',
    URL_FRAGMENT_FORBIDDEN: 'The source URL has a fragment.',
    NONSTANDARD_HTTPS_PORT: 'Only the standard HTTPS port is permitted.',
    INVALID_HOSTNAME: 'The hostname is not valid for this policy.',
    DNS_LOOKUP_FAILED: 'The source hostname could not be resolved.',
    DNS_NO_ADDRESSES: 'DNS returned no addresses for this host.',
    NON_PUBLIC_ADDRESS: 'DNS returned a non-public address; no HTTPS request was made to this host.',
    HTTPS_REQUEST_FAILED: 'The HTTPS request failed before response headers were received.',
    HTTP_STATUS: 'The source returned an unsuccessful HTTP status.',
    REDIRECT_WITHOUT_LOCATION: 'The redirect has no target.',
    REDIRECT_LIMIT_EXCEEDED: 'The maximum number of redirects was exceeded.',
    INVALID_CONTENT_LENGTH: 'The response has an invalid content length.',
    DECLARED_SIZE_EXCEEDED: 'The declared response size exceeds the import limit.',
    CONTENT_ENCODING_NOT_IDENTITY: 'The HTTP content encoding is not supported.',
    STREAM_SIZE_EXCEEDED: 'The received data exceeds the import limit.',
    RESPONSE_BODY_READ_FAILED: 'The response stream could not be read to completion.',
    EMPTY_BODY: 'The response contained no image bytes.',
    INCOMPLETE_BODY: 'Received bytes do not match the expected content length.',
    DEADLINE_EXCEEDED: 'The import deadline expired.',
    PARENT_NOT_FOUND: 'The destination directory does not exist or is not a directory.',
    WRITE_DENIED: 'The operating system denied write access at this stage.',
    ACCESS_DENIED: 'The operating system denied access at this stage.',
    DISK_FULL: 'There is insufficient disk space for this operation.',
    DESTINATION_NOT_ALLOWED: 'The destination path did not pass the local path policy.',
    DESTINATION_CHANGED: 'The resolved destination changed during validation.',
    DESTINATION_EXISTS: 'The destination already exists; it was not overwritten.',
    INVALID_FILE_DESCRIPTOR: 'The attachment descriptor or arguments are invalid.',
    INVALID_TRANSFER_ID: 'Use a transfer ID of 8–80 ASCII letters, digits, underscores or hyphens, starting with a letter or digit.',
    INVALID_DESTINATION_PATH: 'A nonempty absolute destination path is required.',
    TRANSFER_ID_CONFLICT: 'This ID is already bound to a different file or destination.',
    TRANSFER_BUSY: 'All concurrent import slots are occupied.',
    UNSUPPORTED_IMAGE: 'The format, extension or number of image pages is unsupported.',
    IMAGE_EXTENSION_MISMATCH: 'The image format does not match the destination extension.',
    INVALID_IMAGE: 'Image validation or decoding failed.',
    FILE_TOO_LARGE: 'The image exceeds the configured byte limit.',
    INCOMPLETE_DOWNLOAD: 'The download was empty or incomplete.',
    RECEIPT_UNREADABLE: 'The transfer receipt could not be read or validated.',
    FILE_VERIFICATION_FAILED: 'The destination could not be confirmed against its receipt.',
    INTERRUPTED_TRANSFER: 'A transfer receipt exists, but this server is not processing that ID.',
    SOURCE_NOT_ALLOWED: 'The source was rejected by the import policy.',
};

function nextAction(f: FailureFacts, outcome: SaveOutcome, status: Status): string {
    if (outcome === 'published_unverified') return 'check_transfer_status';
    if (status === 'needs_verification') return 'verify_transfer_and_destination';
    if (f.reason === 'HOST_NOT_ALLOWLISTED') return 'check_running_build_and_host_allowlist';
    if (f.code === 'SOURCE_UNAVAILABLE' || f.reason === 'INVALID_FILE_DESCRIPTOR' || f.code === 'SOURCE_NOT_ALLOWED' && f.stage !== 'dns_lookup') return 'reselect_attachment';
    if (f.stage === 'dns_lookup') return 'check_source_dns';
    if (f.reason === 'INVALID_TRANSFER_ID' || f.code === 'TRANSFER_ID_CONFLICT') return 'provide_valid_transfer_id';
    if (f.reason === 'DISK_FULL') return 'free_disk_space';
    if (f.stage.startsWith('receipt_')) return 'check_receipt_store';
    if (f.reason === 'DEADLINE_EXCEEDED') return 'inspect_timed_out_stage';
    if (f.reason === 'DESTINATION_EXISTS') return 'choose_unused_destination';
    if (f.reason === 'TRANSFER_BUSY') return 'wait_for_import_slot';
    if (f.stage.startsWith('destination') || f.stage === 'publish' || f.stage === 'temporary_write') return 'check_destination';
    if (f.stage === 'image_validation' || f.code === 'FILE_TOO_LARGE') return 'check_image_format_and_size';
    if (f.stage.startsWith('http_') || f.stage === 'response_body') return 'check_source_response';
    return 'inspect_reported_stage';
}

const actions: Record<string, string> = {
    check_running_build_and_host_allowlist: 'Check the running build and the exact host allowlist on this computer.',
    check_transfer_status: 'Call get_chat_file_transfer with the same ID before attempting another write.',
    verify_transfer_and_destination: 'Check the receipt and destination before another import.',
    reselect_attachment: 'Select the attachment again in ChatGPT.',
    check_source_dns: 'Check DNS for the reported host.',
    provide_valid_transfer_id: 'Supply a valid, unused ID for a new transfer.',
    provide_original_transfer_id: 'Use the original valid transfer ID of the import you want to check.',
    free_disk_space: 'Free disk space on the affected volume.',
    check_receipt_store: 'Check the local transfer receipt directory and its permissions.',
    inspect_timed_out_stage: 'Inspect the stage, elapsed time and byte count below.',
    choose_unused_destination: 'Choose an unused destination filename.',
    wait_for_import_slot: 'Wait for an active import to finish.',
    check_destination: 'Check the destination, parent directory and local permissions.',
    check_image_format_and_size: 'Check image format, extension and size.',
    check_source_response: 'Check the download source and the recorded network stage.',
    inspect_reported_stage: 'Inspect the reported stage before trying again.',
};
function identity(tool: ChatTool) { return { tool, computer_name: os.hostname(), build_revision: BUILD_REVISION }; }

export function reply(tool: ChatTool, fields: Record<string, unknown>): ServerResult {
    const data = { ...fields, ...identity(tool) };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

export function diagnostic(tool: ChatTool, id: string | undefined, status: Status, outcome: SaveOutcome,
    facts: FailureFacts, opts: { isError?: boolean; replay?: boolean; destination_path?: string } = {}): ServerResult {
    const invalidLookupId = tool === 'get_chat_file_transfer' && facts.reason === 'INVALID_TRANSFER_ID';
    const next_action = invalidLookupId ? 'provide_original_transfer_id' : nextAction(facts, outcome, status);
    const retry_policy = invalidLookupId ? 'query_original_valid_id' : status === 'needs_verification' ? 'check_same_id_before_retry'
        : status === 'failed' ? 'new_id_after_fix'
        : !id || facts.code === 'TRANSFER_ID_CONFLICT' ? 'provide_new_valid_id' : 'same_id_after_fix_for_same_file_and_path';
    const data = { ...facts, ...identity(tool), ...(id ? { transfer_id: id } : {}),
        ...(opts.destination_path ? { destination_path: opts.destination_path } : {}),
        status, save_outcome: outcome, next_action, retry_policy };
    const context = [
        `tool: ${tool}`, `computer: ${data.computer_name}`, `build: ${data.build_revision}`, id && `transfer_id: ${id}`,
        facts.source_host && `source_host: ${facts.source_host}`, facts.http_status !== undefined && `HTTP: ${facts.http_status}`,
        facts.redirect_count !== undefined && `redirect_count: ${facts.redirect_count}`,
        facts.timeout_ms !== undefined && `timeout_ms: ${facts.timeout_ms}`, facts.elapsed_ms !== undefined && `elapsed_ms: ${facts.elapsed_ms}`,
        facts.bytes_received !== undefined && `bytes_received: ${facts.bytes_received}`,
        facts.failure_build_revision && facts.failure_build_revision !== data.build_revision && `failure_build: ${facts.failure_build_revision}`,
    ].filter(Boolean).join('; ');
    const effect = outcome === 'published_unverified' ? 'The destination was published; final confirmation is pending.'
        : outcome === 'unconfirmed' ? 'The saved file is not confirmed.'
        : 'This call did not create the destination file.';
    const retry = retry_policy === 'new_id_after_fix' ? 'A failed receipt exists: use a new transfer ID after fixing the cause.'
        : retry_policy === 'same_id_after_fix_for_same_file_and_path' ? 'After fixing the cause, this ID can be reused for the same file and path.' : '';
    const prior = opts.replay ? 'Previous failed attempt; this replay did not start a download. '
        : tool === 'get_chat_file_transfer' && status === 'failed' ? 'The receipt records a failed import. ' : '';
    const stageNote = facts.stage === 'source_url_validation' ? ' Download did not start.'
        : facts.stage === 'redirect_validation' ? ' The redirect target was not requested.' : '';
    const message = `${facts.code} / ${facts.reason} [${facts.stage}]: ${prior}${explanations[facts.reason] ?? 'The operation failed at the indicated stage.'}${stageNote} ${effect} ${actions[next_action]} ${retry}\n${context}`;
    return { ...(opts.isError !== false ? { isError: true } : {}), content: [{ type: 'text', text: message }], structuredContent: data };
}
