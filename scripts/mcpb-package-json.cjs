function createBundlePackageJson(manifest, packageJson) {
    return {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        type: 'module',
        main: 'dist/index.js',
        author: manifest.author,
        license: manifest.license,
        repository: manifest.repository,
        engines: packageJson.engines,
        dependencies: packageJson.dependencies,
        overrides: packageJson.overrides
    };
}

module.exports = { createBundlePackageJson };
