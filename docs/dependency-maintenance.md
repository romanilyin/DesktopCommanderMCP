# Dependency maintenance for the local Windows fork

The September 2026 hardening updates the MCP SDK, PDF conversion dependencies, Sharp, Tiptap, Markdown and file detection packages while keeping ExcelJS 4.4.0. The supported Node floor is 22.12.0 because of Puppeteer 25; the local installer uses Node 24.21.0. The local Windows installation uses the committed lockfile with `npm ci`.

`@opendocsg/pdf2md` 0.3.2 uses the newer unpdf dependency and removes the old optional canvas → node-pre-gyp → tar chain. Desktop Commander's PDF adapter accepts the new `metadata.info` shape and retains a fallback for the older flat shape. The compatibility suite checks metadata, page selection and extracted images rather than only confirming that a PDF opens.

The upgraded Puppeteer browser installer removes the old proxy/FTP dependency chain. The PDF adapter normalizes its output to a Node Buffer to preserve the existing API. PDF creation must still be checked with a supported Chrome installation and with the application's browser discovery/cache behavior.

## Scoped overrides

| Override | Reason | Required regression |
|---|---|---|
| `exceljs → uuid: 11.1.1` | Retain ExcelJS 4.4.0 while replacing uuid 8. The fixed uuid version still exports CommonJS. | XLSX values, formulas, styles and extended conditional formatting with a valid UUID in serialized XML. |
| `external-editor → tmp: 0.2.7` | Replace the vulnerable temporary-file dependency used by MCPB's interactive CLI chain. Version 0.2.6 has a separate incomplete-fix advisory. | Temporary-file create/read/cleanup and installed MCPB CLI validate/pack. |

These overrides cross the consuming packages' declared version ranges. Keep them scoped, document them in reviews, and rerun their compatibility checks when either package changes. Do not replace them with an unrestricted global override. The MCPB bundle generator propagates the root overrides and Node engine requirement to its production manifest so packaging cannot silently reintroduce the ExcelJS dependency issue.

The unused `nexe` development dependency was removed. MCPB packaging remains supported. Audit both production and development dependencies because the Windows build script installs development tooling.

The existing MCPB builder resolves its production dependencies separately with `npm install`; it does not use the root lockfile. Audit and validate each generated bundle before releasing it. The local Windows installer does not use this packaging path.

## Verification

From a built checkout:

```text
npm run test:local
node local/smoke-test.mjs
npm run test:local-compat
npm audit --omit=dev
npm audit
```

For a machine without Node/npm in PATH, use the explicit configured Node and npm paths shown in the [Windows guide](local-mcp-windows.ru.md).

The GitHub `Local Windows MCP` workflow tests Windows on Node 22.12.0 and 24.21.0, including a build from the lockfile, protocol smoke tests, feature compatibility and both audits. It requires no tunnel credentials. Audit failures are real failures rather than ignored exit codes. A clean audit is a snapshot of the advisory database, not a general guarantee of safety or a replacement for compatibility tests.

Review new findings before changing dependencies. Avoid `npm audit fix --force`: the original report proposed a downgrade from ExcelJS 4.4.0 to 3.4.0, which would require a separate API migration. Preserve PDF, spreadsheet and UI features while addressing the actual dependency chains.

Sources: [PDF converter releases](https://github.com/opengovsg/pdf2md/releases), [uuid advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq), [tmp 0.2.6 advisory](https://github.com/raszi/node-tmp/security/advisories/GHSA-7c78-jf6q-g5cm).
