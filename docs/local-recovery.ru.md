# Восстановление локального туннеля через Планировщик Windows

Пассивный monitor и восстановление туннеля — отдельные процессы. Monitor читает диагностику и пишет очищенные наблюдения; он не вызывает инструменты MCP. `RuntimeWatchdog.ps1` раз в минуту проверяет только состояние сохранённого runtime и существование его процесса. Оба запускаются Планировщиком Windows, поэтому для их работы не нужен открытый Codex.

Задачи работают под текущим пользователем после входа в Windows. Это не служба для работы до входа или после выхода пользователя. Закрытие ноутбука, сон и отсутствие сети также не исправляются перезапуском MCP.

## Правила восстановления

- Восстановление разрешено только если tunnel-client сообщил остановленный runtime, сохранил положительный PID и ожидаемую команду запуска, а Windows подтвердила отсутствие PID.
- Первое наблюдение отсутствия только сохраняется. Повторное спустя минимум 30 секунд разрешает запуск своей задачи Connect (при минутном расписании обычно через 1–2 минуты после сбоя).
- Не более трёх запросов запуска за десять минут, между запросами минимум минута. Запрос считается попыткой даже если задача Connect уже работает или её запуск завершится ошибкой.
- Живой процесс, включая нездоровый или зависший, не завершается. Неясная схема статуса, другая команда, занятый PID другого процесса или повреждённый файл состояния запрещают автоматическое восстановление.
- Если сохранённая запись runtime исчезла вместе с PID, требуется ручной запуск Connect. Watchdog не создаёт новое подключение по догадке.
- `Stop` ставит локальную паузу до остановки туннеля. Задача Connect запускается с `-RespectRecoveryPause`, поэтому поставленная в очередь попытка не отменит намеренную паузу. Обычный ручной `Connect` снимает паузу.

Watchdog не повторяет операции чтения/записи и не запускает пользовательские команды MCP. Зелёные диагностические точки не доказывают, что запись или запуск процесса работают сквозным образом: такую проверку выполняют отдельно, по запросу пользователя.

## Установка в обычном клоне

Сначала установите и проверьте туннель по [основному руководству](local-mcp-windows.ru.md), а monitor — по [руководству наблюдения](local-monitoring.ru.md). Для watchdog нужен PowerShell 7.5 или новее от того же пользователя, который сохранил runtime-ключ. Команды ниже запускаются из корня клона; ключи в конфигурацию watchdog не входят.

Новая `Install-Autostart.ps1` добавляет `-RespectRecoveryPause`. Для существующей задачи сначала проверьте путь скрипта, владельца и аргументы; обновите её действие и отключите собственные повторы при ошибке (`RestartCount = 0`), чтобы повторами управлял watchdog. Остальные параметры сохраните. Не меняйте чужую задачу с совпавшим именем.

```powershell
$repo = (Get-Location).Path
$cfg = Get-Content ./.local/config.json -Raw | ConvertFrom-Json
$state = Join-Path $repo '.local/state'
$connectScript = Join-Path $repo 'local/windows/Tunnel.ps1'
$connectTask = "Desktop Commander ($($cfg.alias))"
$task = Get-ScheduledTask -TaskPath '\' -TaskName $connectTask
# У существующей собственной задачи должен быть флаг -RespectRecoveryPause.
$watchConfig = Join-Path $state 'watchdog-config.json'
@{
    tunnelClientPath = $cfg.tunnelClientPath
    tunnelStateDir = Join-Path $state 'tunnel'
    nodePath = $cfg.nodePath
    launcherRoot = $repo
    connectScript = $connectScript
    powerShellPath = $cfg.powerShellPath
    outputDir = Join-Path $state 'watchdog'
    alias = $cfg.alias
    connectTaskName = $connectTask
    watchdogTaskName = "Desktop Commander watchdog ($($cfg.alias))"
    connectTaskArguments = $task.Actions[0].Arguments
} | ConvertTo-Json | Set-Content -LiteralPath $watchConfig -Encoding utf8

pwsh ./local/windows/RuntimeWatchdog.ps1 -Action Install -ConfigPath $watchConfig
Start-ScheduledTask -TaskPath '\' -TaskName "Desktop Commander watchdog ($($cfg.alias))"
```

Установка проверяет точное действие задачи Connect, её владельца и ограниченный интерактивный контекст. Она отказывается перезаписывать существующую задачу watchdog. Путь `launcherRoot` ограничивает допустимый `local/start-local.mjs`; для установки с каталогами релизов укажите родительский каталог `releases`. При изменении путей или действия Connect обновите конфигурацию watchdog и проверьте её снова.

## Проверка и управление

```powershell
pwsh ./local/windows/RuntimeWatchdog.ps1 -Action Status -ConfigPath $watchConfig
pwsh ./local/windows/RuntimeWatchdog.ps1 -Action Pause -ConfigPath $watchConfig
pwsh ./local/windows/RuntimeWatchdog.ps1 -Action Resume -ConfigPath $watchConfig
# Удаляет только собственную задачу watchdog и оставляет паузу восстановления:
pwsh ./local/windows/RuntimeWatchdog.ps1 -Action Remove -ConfigPath $watchConfig
```

`Pause` останавливает автоматические попытки, но сохраняет работающий туннель. `Resume` разрешает последующие проверки. Для намеренной остановки используйте `Tunnel.ps1 -Action Stop`, а для возобновления — `Tunnel.ps1 -Action Connect`. Прямой вызов бинарника `runtimes stop` не ставит паузу и может быть воспринят как отказ.

В `watchdog/status.json` находятся `observedAt`, код решения, PID и список времени запросов восстановления. `events.jsonl` содержит только изменения решений и запросы запуска; при 1 MiB он ротируется в `.1`. Сырой ответ tunnel-client (он может содержать хвост пользовательского журнала) не сохраняется и не выводится. Коды `status_unknown` и `identity_unconfirmed` требуют проверки конфигурации и статуса вручную; `running_degraded_no_restart` оставляет работающий процесс для диагностики. Ошибка чтения состояния или запуска видна также по `LastTaskResult` задачи.

После установки проверьте: monitor-задача остаётся `Running`, `heartbeatAt` обновляется; watchdog-задача обычно `Ready`, последний результат `0`, а `observedAt` меняется примерно раз в минуту. Затем отдельно проверьте сохранение этих признаков после закрытия Codex и после нового входа Windows. Сам факт регистрации задач не доказывает прохождение этих двух проверок.

```powershell
& $cfg.nodePath --test local/test/monitor-core.test.mjs local/test/monitor.test.mjs local/test/monitor-lifecycle.test.mjs local/test/runtime-recovery-policy.test.mjs
```

Тесты проверяют миграцию и владение задачами с изолированными подстановками, ограничения восстановления, паузу и обработку неизвестного состояния. Они не завершают рабочий MCP.
