# SGG Local MCP

Локальный MCP-сервер для файлов, документов, поиска и терминальных процессов. Проект поддерживается Романом Ильиным и устанавливается из этого репозитория.

Сервер не содержит продуктовую телеметрию, удалённые A/B-тесты, рекламный онбординг и подключение к облачному сервису исходного проекта. Счётчики использования и диагностические журналы остаются локальными. Подробнее: [PRIVACY.md](PRIVACY.md).

## Возможности

- Чтение, запись и точечное редактирование файлов; поиск по именам и содержимому.
- Работа с Markdown, PDF, DOCX, Excel и изображениями.
- Запуск процессов, чтение их вывода и взаимодействие с терминальными сессиями.
- HTML-превью файлов и редактор конфигурации в поддерживающих их MCP-клиентах; настройка `mcpUiPreviewsEnabled` переключает превью и обычные текстовые ответы.
- Импорт выбранных изображений из ChatGPT на конкретный компьютер с проверкой результата по transfer ID.
- Локальная история вызовов и счётчики использования для диагностики.
- Развёртывание на Windows через отдельный private Secure MCP Tunnel для каждого компьютера, с локальным мониторингом и восстановлением runtime.

## Установка на Windows

Нужны Git и **PowerShell 7**. Штатный установщик загружает закреплённые Node.js и OpenAI tunnel-client, проверяет контрольные суммы и размещает runtime в `.local`. Node.js должен быть версии **22.12.0 или новее**.

Полная инструкция по созданию туннеля, настройке ключа и подключению ChatGPT: [локальное развёртывание](docs/local-mcp-windows.ru.md).

```powershell
git clone https://github.com/romanilyin/DesktopCommanderMCP.git C:\Work\DesktopCommanderMCP
Set-Location C:\Work\DesktopCommanderMCP

# Подставьте ID своего private tunnel, созданного для этого компьютера.
./local/windows/Install.ps1 -TunnelId 'ВАШ_TUNNEL_ID' -Name 'SGG Local MCP - Home-PC' -Alias home
./local/windows/Save-Key.ps1
./local/windows/Tunnel.ps1 -Action Connect
./local/windows/Tunnel.ps1 -Action Status
```

Runtime key вводится в защищённый prompt `Save-Key.ps1`, а не в командную строку. Для каждого компьютера создаются собственные туннель, ключ и локальная конфигурация. Каталог `.local` не переносится между компьютерами и не добавляется в Git.

### Обновление существующего экземпляра

```powershell
Set-Location C:\Work\DesktopCommanderMCP
git pull --ff-only
./local/windows/Build.ps1
```

После сборки перезапустите **свой** runtime, чтобы он загрузил новый код. Если сервер работает из отдельного каталога установленной версии, обновите этот каталог по принятой схеме развёртывания. Сборка клона сама по себе не меняет уже запущенный процесс.

Существующие имена задач, профили туннелей и конфигурация сохраняются. CLI-имя `desktop-commander` оставлено как совместимый alias; основное имя — `sgg-local-mcp`.

## Прямое stdio-подключение

Для MCP-клиента на том же компьютере достаточно собранного сервера. Пример конфигурации:

```json
{
  "mcpServers": {
    "sgg-local-mcp": {
      "command": "C:/path/to/node.exe",
      "args": ["C:/Work/DesktopCommanderMCP/dist/index.js"]
    }
  }
}
```

Используйте реальный путь к Node.js. Команда `npm start` запускает тот же stdio-сервер и ожидает MCP-сообщения от клиента.

## Сборка и проверки

Для уже установленного Windows-экземпляра используйте `local/windows/Build.ps1`. Для среды с совместимым Node.js в `PATH`:

```sh
npm ci --include=dev --ignore-scripts
npm rebuild @vscode/ripgrep esbuild sharp
npm run build
npm run test:local
npm test
```

Сборка сначала очищает `dist`, чтобы удалённые модули не остались в установленной версии. `npm run test:local-compat` проверяет интеграции документов; для создания PDF требуется Chrome/Chromium.

Имя пакета — `@romanilyin/sgg-local-mcp`; пакет помечен `private: true`. Публичная npm-установка и автоматическая публикация в каталоги не настроены. `npm run build:mcpb` собирает локальный MCPB-пакет для совместимого клиента.

## Эксплуатация

- [Файлы локального развёртывания](local/README.md)
- [Пассивный мониторинг](docs/local-monitoring.ru.md)
- [Восстановление runtime](docs/local-recovery.ru.md)
- [Импорт изображений из ChatGPT](docs/chat-file-import.ru.md)
- [Проверка источника вложения](docs/chat-file-probe.ru.md)
- [Поддержка зависимостей](docs/dependency-maintenance.md)
- [Частые вопросы](FAQ.md)
- [Сборка и упаковка](PUBLISH.md)
- [Конфиденциальность](PRIVACY.md) и [безопасность](SECURITY.md)

Сервер выполняет команды с правами запустившего его пользователя. Настройки каталогов и команд относятся к MCP-инструментам и не заменяют изоляцию учётной записи или операционной системы.

## Лицензия

MIT. Исходные авторские уведомления сохранены в [LICENSE](LICENSE). Лицензия vendored MCPB schema находится в [scripts/vendor/mcpb/LICENSE](scripts/vendor/mcpb/LICENSE).
