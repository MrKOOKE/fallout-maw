# Публикация Fallout-MaW через Google Drive

Сборка включает всё содержимое системы, кроме `.git`, `.cursor`, `docs` и `scripts`. Файл `system.json` внутри архива заменяется релизной копией с публичными полями `url`, `manifest` и `download`.

## Первый выпуск

1. Выполнить `npm run release:drive:prepare`.
2. Загрузить `system.json` и `fallout-maw.zip` из `Data/outputs/fallout-maw-drive-release` на Google Drive.
3. Для обоих файлов включить доступ «Все, у кого есть ссылка» с ролью читателя.
4. Скопировать `docs/release.google-drive.example.json` в `docs/release.google-drive.json`.
5. Вставить ID файлов из ссылок Google Drive. В ссылке вида `https://drive.google.com/file/d/FILE_ID/view` нужен фрагмент `FILE_ID`.
6. Проверить план командой `npm run release:drive:check`.
7. Собрать полный архив командой `npm run release:drive:build`.
8. На Google Drive открыть каждый ранее загруженный файл: «Сведения о файле» → «Управление версиями» → «Загрузить новую версию». Для `system.json` и `fallout-maw.zip` загрузить одноимённые итоговые файлы из `Data/outputs/fallout-maw-drive-release`. Это сохраняет их первоначальные ID и ссылки.
9. В Foundry открыть установку игровых систем и вставить прямой Manifest URL, показанный командой сборки.

## Обновление

1. Увеличить `version` одновременно в `system.json` и `package.json`.
2. Запустить проверки проекта.
3. Снова выполнить `npm run release:drive:build`.
4. Загрузить оба результата как новые версии существующих файлов Google Drive, не создавая новые файлы.
5. Проверить установку на отдельной тестовой папке данных Foundry.

Google Drive не является специализированным хранилищем релизов. Прямая ссылка `drive.usercontent.google.com` должна быть проверена с компьютера, на котором нет входа в аккаунт владельца. Если Google вернёт HTML-страницу подтверждения или ограничит трафик, Foundry не сможет установить систему по manifest URL; тогда архив следует перенести в объектное хранилище с настоящим прямым HTTPS URL.
