# Fallout-MaW Launcher и публикация обновлений

## Что теперь есть

Лаунчер — отдельное переносимое Windows-приложение. Он не содержит и не распространяет Foundry VTT: у пользователя должна быть собственная лицензионная установка Foundry.

Клиент умеет:

- находить стандартную папку `FoundryVTT\Data` и ставить систему в `systems\fallout-maw`;
- проверять ECDSA-подпись канала обновлений, затем размер и SHA-256 архива;
- продолжать прерванную загрузку через HTTP Range;
- выбирать цепочку патчей, если она меньше полного архива;
- проверять существующую установку перед первым патчем;
- запрещать обновление при запущенном Foundry;
- отбрасывать опасные пути, symlink, NTFS ADS и path traversal из ZIP;
- готовить новую версию в staging-каталоге и заменять систему через rename-транзакцию с журналом восстановления;
- сохранять `storage/**` при установке, обновлении и откате;
- хранить предыдущую рабочую версию для кнопки «Откатить»;
- отклонять подписанный rollback канала по монотонному `sequence`.

Полный пакет сейчас близок к 10 ГиБ, причём почти весь объём приходится на `Library-animation`, `assets` и `audio`. Поэтому полный ZIP нужен для первой установки и ремонта, а обычные выпуски должны идти небольшими патчами.

## Один раз: ключ издателя

```powershell
npm run release:keygen
```

Команда создаёт ECDSA P-256 ключи вне репозитория:

```text
Data\release-keys\fallout-maw\private-key.pem
Data\release-keys\fallout-maw\public-key.pem
Data\release-keys\fallout-maw\key-info.json
```

`private-key.pem` нельзя загружать в облако, Git, Discord или отправлять пользователям. Сделайте зашифрованную резервную копию: без этого ключа нельзя подписать продолжение уже опубликованного канала. Публичный ключ встраивается в EXE при сборке лаунчера.

## Первый выпуск

1. Установить одинаковую версию в `package.json` и `system.json`.
2. Добавить заметку о версии в `release/release-config.json` (`releaseNotes` может быть строкой либо объектом с `versions`).
3. Запустить проверки:

```powershell
npm run check
npm run release:test
npm run launcher:test
```

4. Создать начальный snapshot:

```powershell
npm run release:snapshot
npm run release:verify
```

Результат находится в `Data\outputs\fallout-maw-release`. Состояние цепочки находится отдельно в `Data\release-state\fallout-maw\stable.json`; его тоже нужно резервировать, но не публиковать.

Сборщик использует только явный runtime allowlist:

```text
system.json, README.md,
assets/, audio/, calendar/, icons/, lang/, Library-animation/,
packs/, simple-quest/, src/, storage/, styles/, templates/
```

`calendar-src`, `LOST`, `_codex`, `docs`, `scripts`, `tests`, `.git`, старые архивы и прочие рабочие файлы в релиз не попадают.

### Переход с уже опубликованной 0.2.1

Для текущего проекта не нужно заставлять существующих пользователей повторно скачивать старую базу. Сохранённый legacy file index можно принять как базовую версию без сборки старого 10‑гигабайтного архива:

```powershell
npm run release:adopt -- --index "..\..\outputs\fallout-maw-launcher\fallout-maw-file-index-0.2.1.json"
```

Команда создаёт только приватный state для `0.2.1`, исключает `storage/**` и ничего не публикует. После этого увеличьте версию до `0.2.2` или выше и выполните `npm run release:patch`. Старые dev-файлы, которые попадали в прежний denylist-архив, будут явно удалены патчем. Если конкретная установка пользователя не совпадает со старым индексом, лаунчер безопасно перейдёт на полный пакет.

## Обычное обновление

1. Закончить изменения и увеличить SemVer одновременно в `package.json` и `system.json` одной командой, например:

```powershell
npm run release:version -- 0.2.2
```

Команда принимает только версию выше текущей и атомарно меняет оба manifest-файла.
2. Обновить release notes.
3. Выполнить проверки проекта.
4. Собрать полный fallback-пакет и патч от последней опубликованной версии:

```powershell
npm run release:patch
npm run release:verify
```

Повторная команда с той же версией разрешена только если управляемые файлы не изменились. Изменять уже созданный immutable-артефакт нельзя: для нового содержимого требуется новая версия.

Патч содержит:

- `_fallout-maw-patch.json` с `from`, `to`, fingerprint, writes и deletes;
- `_fallout-maw-base.json` для проверки ранее установленной версии;
- `_fallout-maw-release.json` с целевым файловым индексом;
- `payload/` только с новыми и изменёнными файлами.

`storage/**` присутствует в полном архиве как seed для чистой установки, но исключён из managed fingerprint, writes и deletes.

## Сборка клиентского EXE

```powershell
npm run launcher:build
```

Результат:

```text
Data\outputs\fallout-maw-launcher\Fallout-MaW-Launcher.exe
Data\outputs\fallout-maw-launcher\Fallout-MaW-Launcher-win-x64.zip
```

Это self-contained `win-x64` сборка, поэтому пользователю не нужен установленный .NET Runtime. До подключения облака адрес канала можно вставить в интерфейсе. После подключения задайте `manifestUrl` или `publicBaseUrl` в локальном `release/publisher.local.json` и пересоберите EXE — тогда он будет работать без настройки пользователя.

Для публичного распространения желательно подписать EXE Authenticode-сертификатом:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File launcher/build-launcher.ps1 `
  -SigningCertificateThumbprint "THUMBPRINT"
```

Без коммерческой подписи Windows SmartScreen может показывать «Неизвестный издатель», даже если канал обновлений корректно защищён ECDSA.

## Структура публичного облака

```text
channels/stable.json
channels/stable.json.sig
foundry/system.json
releases/<version>/fallout-maw-<version>-full.zip
releases/<version>/files.json
patches/<from>-to-<to>/fallout-maw-<from>-to-<to>-patch.zip
```

Версионные файлы неизменяемы и загружаются первыми. Публикация идёт в таком порядке:

1. `releases/**` и `patches/**`;
2. повторная проверка размера и SHA-256 уже загруженных файлов;
3. `foundry/system.json`;
4. `channels/stable.json.sig`;
5. `channels/stable.json` строго последним.

Для immutable-файлов рекомендуется `Cache-Control: public, max-age=31536000, immutable`, для трёх mutable-файлов — `no-cache`. Хранилище должно отдавать настоящий HTTPS-файл, `Content-Length`, `ETag` и `Accept-Ranges`.

Параметры и секреты конкретного S3-совместимого провайдера будут подключены в `release/publisher.local.json` и переменных окружения после выдачи доступа. Они не должны попадать в исходники или EXE.

## Важные эксплуатационные ограничения

- Перед обновлением Foundry должен быть полностью закрыт, иначе LevelDB может удерживать `LOCK`.
- Для первой установки требуется примерно размер архива плюс распакованная система; для полного обновления дополнительно нужна staging-копия.
- Последний backup занимает место рядом с системой. Лаунчер заменяет старый backup при следующем обновлении.
- Права на распространение `Library-animation`, аудио, изображений и защищённого содержимого `simple-quest` необходимо подтвердить до публичного релиза.
