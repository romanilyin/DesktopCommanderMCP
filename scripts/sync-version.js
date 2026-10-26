import { readFileSync, writeFileSync } from 'node:fs';

function bumpVersion(version, type = 'patch') {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error('Automatic version bumps require a stable major.minor.patch version');
    }
    const [major, minor, patch] = version.split('.').map(Number);
    if (type === 'major') return `${major + 1}.0.0`;
    if (type === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

const shouldBump = process.argv.includes('--bump');
const bumpType = process.argv.includes('--major') ? 'major'
    : process.argv.includes('--minor') ? 'minor' : 'patch';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (shouldBump) {
    pkg.version = bumpVersion(pkg.version, bumpType);
    writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.name = pkg.name;
lock.version = pkg.version;
lock.packages[''].name = pkg.name;
lock.packages[''].version = pkg.version;
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
const manifest = JSON.parse(readFileSync('manifest.template.json', 'utf8'));
manifest.version = pkg.version;
writeFileSync('manifest.template.json', JSON.stringify(manifest, null, 2) + '\n');
writeFileSync('src/version.ts', `export const VERSION = '${pkg.version}';\n`);
console.log(`Version ${pkg.version} synchronized across package.json, package-lock.json, manifest.template.json and src/version.ts`);
