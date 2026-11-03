import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const archiveRevision = '$Format:%H$'; // Expanded by git archive via .gitattributes.
const isCommit = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function buildRevision() {
    if (isCommit(archiveRevision)) return archiveRevision;
    // Never use a containing repository's HEAD for an unpacked source directory.
    if (!existsSync(path.join(root, '.git'))) return 'unknown';
    const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        const head = git('rev-parse', '--verify', 'HEAD');
        if (!isCommit(head)) return 'unknown';
        return git('status', '--porcelain', '--untracked-files=normal') ? head + '-dirty' : head;
    } catch { return 'unknown'; }
}

const revision = buildRevision();
writeFileSync(path.join(root, 'dist', 'utils', 'build-revision.js'),
    'export const BUILD_REVISION = ' + JSON.stringify(revision) + ';\n', 'utf8');
console.log('MCP build revision:', revision);
