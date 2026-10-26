# Разработка и локальная упаковка SGG Local MCP

Пакет `@romanilyin/sgg-local-mcp` помечен `private: true`. Этот репозиторий не содержит автоматическую публикацию npm, MCP Registry или marketplace. Рабочий путь установки — checkout исходников и локальная сборка.

## Сборка

Для установленного Windows-экземпляра:

```powershell
./local/windows/Build.ps1
```

В среде с Node.js 22.12.0 или новее:

```sh
npm ci --include=dev --ignore-scripts
npm rebuild @vscode/ripgrep esbuild sharp
npm run build
npm run test:local
npm test
```

`build` очищает `dist` перед компиляцией. Это необходимо, чтобы удалённые исходники не оставляли исполняемые файлы предыдущей версии. Проверка документных интеграций: `npm run test:local-compat`.

## Версия

`package.json` — источник версии. `npm run sync-version` переносит её в корень lockfile, `manifest.template.json` и `src/version.ts`. Команды `npm run bump`, `bump:minor` и `bump:major` увеличивают версию и синхронизируют эти файлы. Они ничего не публикуют и не создают git-теги.

После изменения зависимостей обновите lockfile и проверьте чистую установку по [инструкции поддержки зависимостей](docs/dependency-maintenance.md).

## MCPB

```sh
npm run build:mcpb
```

Скрипт собирает исходники, подготавливает платформенные ripgrep binaries, создаёт production bundle, проверяет manifest локальной JSON schema и упаковывает `sgg-local-mcp-<version>.mcpb`. Manifest содержит ссылки на этот репозиторий и его privacy policy. Сборка требует сети для загрузки зависимостей и двоичных компонентов.

Проверяйте готовый пакет в совместимом клиенте. Перенос сборки на рабочую машину и перезапуск её runtime выполняются отдельно; создание MCPB само по себе не меняет подключённые компьютеры.

## Лицензии

В распространяемой сборке сохраняются `LICENSE` и необходимые уведомления сторонних компонентов. Vendored MCPB schema сопровождается `scripts/vendor/mcpb/LICENSE`. Ребрендинг не меняет эти авторские уведомления.
