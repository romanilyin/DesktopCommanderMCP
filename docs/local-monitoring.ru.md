# Пассивное наблюдение за локальным MCP и Secure Tunnel

Локальный monitor собирает временную картину состояния MCP-процесса и tunnel-client, чтобы сопоставить новые сбои `409` или задержки с доступностью endpoints, инициализациями MCP, поколением дочернего процесса и накоплением запросов. Он наблюдает за сервером, но сам не вызывает MCP-инструменты, не повторяет запросы и не перезапускает MCP или туннель.

## Запуск на обычной установке

Откройте PowerShell 7 в каталоге клона Desktop Commander. Сначала убедитесь, что команды выполняются на ожидаемом компьютере и в нужном клоне:

```powershell
hostname
$env:COMPUTERNAME
Get-Location
```

Запустите monitor:

```powershell
pwsh ./local/windows/Monitor.ps1 -Action Start
```

Команда запускает наблюдение с интервалом 10 секунд. Она опрашивает локальные endpoints `/healthz`, `/readyz`, `/health/mcp` и `/metrics`, а также добавляет новые строки доступного tunnel-client лога в очищенном виде. Она не читает содержимое пользовательских файлов и не сохраняет команды, переданные MCP-инструментам. Пользовательский `intervalMs` допускается в диапазоне от 1000 до 60000 миллисекунд.

Посмотреть текущее состояние и завершить monitor:

```powershell
pwsh ./local/windows/Monitor.ps1 -Action Status
pwsh ./local/windows/Monitor.ps1 -Action Stop
```

`Status` читает состояние наблюдателя и последние записанные измерения. `Stop` останавливает только monitor-процесс; MCP и соединение Secure Tunnel остаются нетронутыми. Запуск monitor не требует сборки проекта, повторного подключения ChatGPT или перезапуска локального MCP. Обёртка использует Node и alias из `.local/config.json`, а свою служебную конфигурацию хранит в `.local/state/monitor-config.json`.

## Наблюдение за отдельным существующим клоном

В обычном режиме wrapper сам создаёт `.local/state/monitor-config.json` на основе `.local/config.json` этого checkout. `-ConfigPath` — это путь к конфигурации самого monitor, не MCP-конфигурация. Для legacy-копии используйте её существующие файлы health URL и tunnel-client лога. Укажите фактический alias legacy-туннеля и создайте конфиг monitor:

```powershell
$legacyRoot = Join-Path $env:USERPROFILE 'Documents\Codex\DesktopCommanderLocal'
$monitorConfigPath = Join-Path $legacyRoot 'state\monitor-config.json'
$alias = 'desktop-commander-legacy' # Replace with the alias used by this tunnel.
$legacyMonitorConfig = @{
  healthUrlFile = Join-Path $legacyRoot "state\tunnel\health\$alias.url"
  tunnelLogFile = Join-Path $legacyRoot "state\tunnel\logs\$alias.log"
  outputDir = Join-Path $legacyRoot 'state\monitor'
  intervalMs = 10000
}
$legacyMonitorConfig | ConvertTo-Json | Set-Content -LiteralPath $monitorConfigPath -Encoding utf8
$cfg = Get-Content ./.local/config.json -Raw | ConvertFrom-Json
pwsh ./local/windows/Monitor.ps1 -Action Start -ConfigPath $monitorConfigPath -NodePath $cfg.nodePath
pwsh ./local/windows/Monitor.ps1 -Action Status -ConfigPath $monitorConfigPath
pwsh ./local/windows/Monitor.ps1 -Action Stop -ConfigPath $monitorConfigPath
```

`-ConfigPath` должен указывать на JSON monitor со всеми четырьмя полями, причём `healthUrlFile`, `tunnelLogFile` и `outputDir` должны быть абсолютными путями. Не копируйте в него Tunnel ID или ключ. Для `Start` и `InstallAutostart` с пользовательским `-ConfigPath` также задайте абсолютный путь к совместимому Node.js — например `nodePath` текущего клона, как в примере выше:

```powershell
pwsh ./local/windows/Monitor.ps1 -Action Start -ConfigPath 'C:\путь\к\monitor-config.json' -NodePath 'C:\путь\к\node.exe'
pwsh ./local/windows/Monitor.ps1 -Action InstallAutostart -ConfigPath 'C:\путь\к\monitor-config.json' -NodePath 'C:\путь\к\node.exe' -TaskName 'Desktop Commander monitor - Legacy'
```

Путь `-NodePath` должен указывать на абсолютный путь к `node.exe`. `-TaskName` необязателен. Для `Status`, `Stop` и удаления автозапуска `-NodePath` не нужен; укажите тот же `-ConfigPath` и имя задачи, если оно было задано при установке.

Проверьте `hostname` и путь перед запуском: имя подключения в ChatGPT не подтверждает, какой сервер выбран монитором. Monitor использует адреса и параметры локального экземпляра из указанной конфигурации. Для наблюдения за установленной legacy-копией используйте именно её конфиг; не меняйте рабочий `.local/config.json` основного клона ради мониторинга.

## Автозапуск

После ручной проверки monitor можно запускать автоматически при входе текущего пользователя в Windows:

```powershell
pwsh ./local/windows/Monitor.ps1 -Action InstallAutostart
```

Удалить задачу автозапуска:

```powershell
pwsh ./local/windows/Monitor.ps1 -Action RemoveAutostart
```

Для пользовательского monitor-конфига установку и удаление задачи выполняйте с тем же `-ConfigPath`. Передайте тот же `-TaskName`, если задавали его при установке:

```powershell
pwsh ./local/windows/Monitor.ps1 -Action InstallAutostart -ConfigPath $monitorConfigPath -NodePath $cfg.nodePath -TaskName 'Desktop Commander monitor - Legacy'
pwsh ./local/windows/Monitor.ps1 -Action RemoveAutostart -ConfigPath $monitorConfigPath -TaskName 'Desktop Commander monitor - Legacy'
```

Автозапуск относится только к наблюдателю и срабатывает при входе пользователя. Он не включает watchdog для MCP. При потере внешней сети monitor может продолжать опрашивать локальные endpoints и фиксировать недоступность или устаревание tunnel polling; для этого не требуется доступ в интернет. После выключения компьютера или выхода пользователя процесс monitor не работает.

## Где искать данные

Для обычного клона monitor пишет конфигурацию в `.local/state/monitor-config.json`, а статус и журналы — в `.local/state/monitor`:

- `status.json` — последнее состояние наблюдателя, его PID, heartbeat, последняя health/metrics сводка и недавние samples;
- `samples.jsonl` — измерения доступности и метрик;
- `incidents.jsonl` — новые замеченные условия (например, новые ответы 409, churn и насыщение очереди);
- `events.jsonl` — последовательность нормализованных наблюдаемых событий из очищенного tunnel лога;
- `launcher.stdout.log` и `launcher.stderr.log` — вывод обёртки и диагностические сообщения запуска monitor.

Путь каталога данных monitor задаётся полем `outputDir` в его конфигурации. JSONL журналы ротируются при достижении 2 MiB; хранятся четыре предыдущих поколения. Monitor присоединяется к tunnel-client логу с конца файла, поэтому историческое содержимое не импортируется. Файлы локальные и предназначены для диагностики. В журнал не записываются API-ключи, содержимое файлов, команды инструментов или тела MCP-запросов. В событиях разрешены только поля по whitelist; идентификаторы корреляции очищаются и хешируются.

## Как читать наблюдения

Сравнивайте новые события с временными отметками доступности `/healthz`, `/readyz` и `/health/mcp`, метриками `/metrics`, а также `details.child_generation` и `details.initialize_epoch` из `/health/mcp`. В сохранённом sample поколение процесса представлено только хешем `health.childGenerationHash`; epoch — как `health.initializeEpoch`.

`childGenerationHash` и `initializeEpoch` помогают заметить смену локального child-процесса и MCP handshake-эпохи, не записывая исходный идентификатор child. Если новый 409 совпадает с переинициализацией или сменой child, это помогает отличить churn соединения от отказа отдельного инструмента. Если здоровье инициализации стабильно, а очередь ожиданий или задержки растут, это указывает на другую область расследования. Само совпадение не доказывает причинность; сопоставьте несколько samples и события одного временного окна.

`details.initialize_epoch` в `/health/mcp` и счётчики ответов 409 в `/metrics` относятся к текущему процессу и накапливаются со временем. Начальные значения могут отражать старые запросы; без временного приращения нельзя приписать счётчик новому инциденту или конкретной дате. `/healthz`, `/readyz` и `/health/mcp` при этом могут оставаться зелёными. Используйте первый sample monitor как baseline и смотрите на изменения в следующих samples.

HTTP 409 сам по себе не доказывает, что операция записи не выполнилась, что у пользователя не хватает разрешений или что повтор запроса безопасен. Проверяйте статус вызова и фактический результат операции перед любой ручной попыткой. Monitor не воспроизводит проблемный вызов.

Событие `command_response_deadline` означает, что в новых строках лога tunnel-client обнаружено отбрасывание запросов или ответов по истечении срока ответа. Tunnel-client записывает эти сообщения с уровнем INFO; они могут появляться при зелёных endpoints, свежем polling и неизменных счётчиках 5xx. Поле `tunnelLog.deadlineDropCount` — количество таких записей за текущий опрос, а не накопленный счётчик и не гарантированное число уникальных запросов. Исторические записи до запуска monitor не учитываются. Это свидетельство отказа доставки, но само по себе не устанавливает причину и не подтверждает, успела ли выполниться операция. Следующий шаг — сопоставить время события с `initializeEpoch`, `childGenerationHash`, очередью и завершением конкретного вызова. Зелёный статус диагностических точек не заменяет проверку запуска процесса и записи с обратным чтением, когда такая проверка явно разрешена пользователем.

Длительность `get_more_search_results` или чтения процесса также не обязательно означает сбой туннеля: это может быть время работы фоновой операции. Сопоставьте задержку с `/readyz`, новым `initialize_epoch`, сменой `child_generation` и событиями очереди или переподключения в очищенном логе туннеля.

## Локальные проверки monitor

Запускайте unit-тесты наблюдателя через Node, который установлен в конфигурации этого клона:

```powershell
$cfg = Get-Content ./.local/config.json -Raw | ConvertFrom-Json
$monitorTests = Get-ChildItem local/test/monitor*.test.mjs -File | ForEach-Object { $_.FullName }
& $cfg.nodePath --test $monitorTests
```

Для одиночного измерения без фонового цикла monitor CLI поддерживает `--once`:

```powershell
$cfg = Get-Content ./.local/config.json -Raw | ConvertFrom-Json
& $cfg.nodePath ./local/monitor.mjs --config (Join-Path (Get-Location) '.local/state/monitor-config.json') --once
```

Сквозное наблюдение настраивайте только для уже работающего локального экземпляра, который вы намеренно хотите измерять. Monitor пассивно обращается к health/metrics endpoints и читает журнал туннеля; он не отправляет MCP-вызовы и не перезапускает процессы.

## Справка

Secure MCP Tunnel инициирует исходящее соединение от локального компьютера; для работы не требуется открывать публичный входящий порт в Windows Firewall или роутере. См. [документацию OpenAI по Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
