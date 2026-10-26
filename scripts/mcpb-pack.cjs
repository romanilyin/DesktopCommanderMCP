// Unsigned MCPB is a ZIP archive: https://github.com/modelcontextprotocol/mcpb
// Schema and exclusion patterns: @anthropic-ai/mcpb 1.2.0 (MIT), see vendor/mcpb/LICENSE.
// Avoid the CLI's unused signing dependency on the unpatched node-forge package.
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const JSZip = require('jszip');
const ignore = require('ignore');
const schema = require('./vendor/mcpb/manifest-v0.3.schema.json');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const EXCLUDE_PATTERNS = [
    '.DS_Store', 'Thumbs.db', '.gitignore', '.git', '.mcpbignore', '*.log', '.env*',
    '.npm', '.npmrc', '.yarnrc', '.yarn', '.eslintrc', '.editorconfig', '.prettierrc',
    '.prettierignore', '.eslintignore', '.nycrc', '.babelrc', '.pnp.*',
    'node_modules/.cache', 'node_modules/.bin', '*.map', 'npm-debug.log*',
    'yarn-debug.log*', 'yarn-error.log*', 'package-lock.json', 'yarn.lock',
    '*.mcpb', '*.d.ts', '*.tsbuildinfo', 'tsconfig.json',
];

function confinedFile(root, relative) {
    if (!relative || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) {
        throw new Error('Bundle assets must use relative paths');
    }
    const file = fs.realpathSync(path.resolve(root, relative));
    const offset = path.relative(fs.realpathSync(root), file);
    if (!offset || offset === '..' || offset.startsWith('..' + path.sep) || path.isAbsolute(offset)) {
        throw new Error('Bundle asset escapes its directory');
    }
    if (!fs.statSync(file).isFile()) throw new Error('Bundle asset is not a file');
    return file;
}

function validateManifest(root) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    if (!validate(manifest)) throw new Error(ajv.errorsText(validate.errors));
    if (manifest.manifest_version !== '0.3' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) {
        throw new Error('Unsupported manifest version or invalid bundle name');
    }
    confinedFile(root, manifest.server.entry_point);
    for (const icon of [manifest.icon, ...(manifest.icons ?? []).map(item => item.src)].filter(Boolean)) {
        const bytes = fs.readFileSync(confinedFile(root, icon));
        if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
            throw new Error('Bundle icon must be PNG');
        }
    }
    return manifest;
}

async function packBundle(root, output) {
    validateManifest(root);
    const zip = new JSZip();
    const ignored = ignore().add(EXCLUDE_PATTERNS);
    const ignoreFile = path.join(root, '.mcpbignore');
    if (fs.existsSync(ignoreFile)) ignored.add(fs.readFileSync(ignoreFile, 'utf8'));
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name);
            const relative = path.relative(root, file).split(path.sep).join('/');
            if (ignored.ignores(relative + (entry.isDirectory() ? '/' : ''))) continue;
            if (entry.isSymbolicLink()) throw new Error('Bundle contains a symbolic link: ' + relative);
            if (entry.isDirectory()) walk(file);
            else {
                const stat = fs.statSync(file);
                if (!stat.isFile()) throw new Error('Bundle contains a non-regular file: ' + relative);
                zip.file(relative, fs.readFileSync(file), { unixPermissions: stat.mode, date: stat.mtime });
            }
        }
    }
    walk(root);
    // Never produce a bundle whose required assets were excluded by ignore rules.
    const manifest = validateManifest(root);
    for (const asset of ['manifest.json', manifest.server.entry_point, manifest.icon,
        ...(manifest.icons ?? []).map(item => item.src)].filter(Boolean)) {
        if (!zip.file(asset.split(path.sep).join('/'))) throw new Error('Required bundle asset excluded: ' + asset);
    }
    const temporary = output + '.' + randomUUID() + '.tmp';
    try {
        await pipeline(zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE', platform: 'UNIX' }),
            fs.createWriteStream(temporary, { flags: 'wx' }));
        await fs.promises.rename(temporary, output);
    } finally {
        await fs.promises.rm(temporary, { force: true });
    }
}

module.exports = { validateManifest, packBundle };
