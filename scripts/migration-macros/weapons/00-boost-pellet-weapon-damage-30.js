// Fallout-MaW: увеличить урон дробового оружия на 30%.
// Вставить целиком в макрос типа "Скрипт" и запустить от имени GM.
//
// Критерии оружейной функции:
//   1. Количество дробин (pellets) больше 1.
//   2. Активное действие "Залп" (availableActions.volley) выключено.
//
// Обрабатываются мировые Items, Items мировых актёров, Items несвязанных
// токенов на сценах и мировые Item/Actor compendium-паки.

void (async () => {
  const SYSTEM_ID = "fallout-maw";
  const DAMAGE_MULTIPLIER = 1.3;

  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error(`Этот макрос предназначен только для ${SYSTEM_ID}.`);
    return;
  }

  if (!game.user?.isGM) {
    ui.notifications.error("Макрос должен запускать GM.");
    return;
  }

  const DialogV2 = foundry.applications.api.DialogV2;
  const confirmed = await DialogV2.confirm({
    window: {
      title: "Увеличить урон дробового оружия",
      icon: "fa-solid fa-gun"
    },
    content: [
      "<p>Увеличить на <strong>30%</strong> урон всех оружейных функций, у которых дробин больше 1 и неактивен «Залп»?</p>",
      "<p>Результат округляется до ближайшего целого через <code>Math.round</code>.</p>",
      "<p class=\"notification warning\"><strong>Внимание:</strong> повторный запуск добавит ещё 30% к уже изменённому урону.</p>"
    ].join(""),
    yes: { label: "Изменить урон", icon: "fa-solid fa-check" },
    no: { label: "Отмена", icon: "fa-solid fa-xmark" },
    rejectClose: false,
    modal: true
  });
  if (!confirmed) return;

  const stats = {
    scannedItems: 0,
    updatedItems: 0,
    updatedWeaponFunctions: 0,
    skippedInvalidDamage: 0,
    skippedPacks: 0,
    errors: 0
  };
  const changes = [];
  const errors = [];

  ui.notifications.info("Fallout-MaW: обновляю урон дробового оружия...");

  // Мировые предметы.
  for (const item of game.items?.contents ?? []) {
    await updateItemDocument(item, "Мировой предмет");
  }

  // Предметы мировых актёров.
  for (const actor of game.actors?.contents ?? []) {
    await updateActorItems(actor, `Актёр: ${actor.name}`);
  }

  // Несвязанные токены имеют собственные синтетические предметы.
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens?.contents ?? []) {
      if (token.actorLink || !token.actor) continue;
      await updateSyntheticActorItems(token.actor, `Токен: ${scene.name} / ${token.name}`);
    }
  }

  // Только мировые паки: содержимое установленной системы не изменяем.
  for (const pack of game.packs ?? []) {
    if (!isWorldPack(pack)) continue;
    if (!["Item", "Actor"].includes(pack.documentName)) continue;
    await updateWorldPack(pack);
  }

  const summary = [
    `изменено предметов: ${stats.updatedItems}`,
    `оружейных функций: ${stats.updatedWeaponFunctions}`,
    `просканировано предметов: ${stats.scannedItems}`,
    `пропущено нечисловых значений урона: ${stats.skippedInvalidDamage}`,
    `ошибок: ${stats.errors}`
  ].join("; ");

  console.group("Fallout-MaW | +30% урона дробового оружия");
  console.table(changes);
  if (errors.length) console.error("Ошибки:", errors);
  console.log("Итог:", stats);
  console.groupEnd();

  if (stats.errors) ui.notifications.warn(`Готово с ошибками: ${summary}. Подробности — в консоли (F12).`);
  else ui.notifications.info(`Готово: ${summary}. Список изменений — в консоли (F12).`);

  async function updateItemDocument(item, scope) {
    const result = buildItemUpdate(item, scope);
    if (!result) return;

    try {
      await item.update(result.update, { render: false });
      recordSuccess(result.changeRows);
    } catch (error) {
      recordError(`${scope}: ${item.name}`, error);
    }
  }

  async function updateActorItems(actor, scope) {
    const updates = [];
    const rowsByItemId = new Map();

    for (const item of actor.items?.contents ?? []) {
      const result = buildItemUpdate(item, scope);
      if (!result) continue;
      updates.push({ _id: item.id, ...result.update });
      rowsByItemId.set(item.id, result.changeRows);
    }
    if (!updates.length) return;

    try {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });
      for (const update of updates) recordSuccess(rowsByItemId.get(update._id) ?? []);
    } catch (error) {
      recordError(scope, error);
    }
  }

  async function updateSyntheticActorItems(actor, scope) {
    const mergedItems = [];
    const changeRows = [];

    for (const item of actor.items?.contents ?? []) {
      const result = buildItemUpdate(item, scope);
      if (!result) continue;
      mergedItems.push(foundry.utils.mergeObject(item.toObject(), result.update, { inplace: false }));
      changeRows.push(...result.changeRows);
    }
    if (!mergedItems.length) return;

    try {
      await actor.update(
        { items: mergedItems },
        { enforceTypes: false, diff: true, recursive: true, render: false }
      );
      recordSuccess(changeRows);
    } catch (error) {
      recordError(scope, error);
    }
  }

  async function updateWorldPack(pack) {
    const wasLocked = Boolean(pack.locked);
    try {
      if (wasLocked) await pack.configure({ locked: false });
      const documents = await pack.getDocuments();

      if (pack.documentName === "Item") {
        for (const item of documents) {
          await updateItemDocument(item, `Пак: ${pack.collection}`);
        }
      } else {
        for (const actor of documents) {
          await updateActorItems(actor, `Пак: ${pack.collection} / ${actor.name}`);
        }
      }
    } catch (error) {
      recordError(`Пак: ${pack.collection}`, error);
    } finally {
      if (pack.locked !== wasLocked) {
        try {
          await pack.configure({ locked: wasLocked });
        } catch (error) {
          recordError(`Повторная блокировка пака: ${pack.collection}`, error);
        }
      }
    }
  }

  function buildItemUpdate(item, scope) {
    stats.scannedItems += 1;

    const functions = item.system?.functions;
    if (!functions || typeof functions !== "object") return null;

    const update = {};
    const changeRows = [];

    addWeaponFunctionUpdate({
      weapon: functions.weapon,
      updatePath: "system.functions.weapon.damage",
      functionName: "Основное оружие",
      item,
      scope,
      update,
      changeRows
    });

    for (const [id, weapon] of Object.entries(functions.additionalWeapons ?? {})) {
      addWeaponFunctionUpdate({
        weapon,
        updatePath: `system.functions.additionalWeapons.${id}.damage`,
        functionName: weapon?.name || `Доп. оружие ${id}`,
        item,
        scope,
        update,
        changeRows
      });
    }

    return changeRows.length ? { update, changeRows } : null;
  }

  function addWeaponFunctionUpdate({ weapon, updatePath, functionName, item, scope, update, changeRows }) {
    if (!isTargetWeaponFunction(weapon)) return;

    const oldDamage = Number(weapon.damage);
    if (!Number.isFinite(oldDamage)) {
      stats.skippedInvalidDamage += 1;
      console.warn("Fallout-MaW | Пропущен нечисловой урон", {
        scope,
        item: item.name,
        functionName,
        damage: weapon.damage
      });
      return;
    }

    const newDamage = Math.round(oldDamage * DAMAGE_MULTIPLIER);
    if (newDamage === oldDamage) return;

    // damage — StringField, поэтому записываем строку.
    update[updatePath] = String(newDamage);
    changeRows.push({
      scope,
      item: item.name,
      uuid: item.uuid,
      weaponFunction: functionName,
      pellets: Number(weapon.pellets),
      oldDamage,
      newDamage
    });
  }

  function isTargetWeaponFunction(weapon) {
    if (!weapon || typeof weapon !== "object") return false;
    const pellets = Number(weapon.pellets);
    if (!Number.isFinite(pellets) || pellets <= 1) return false;
    return weapon.availableActions?.volley !== true;
  }

  function recordSuccess(changeRows) {
    if (!changeRows.length) return;
    stats.updatedItems += 1;
    stats.updatedWeaponFunctions += changeRows.length;
    changes.push(...changeRows);
  }

  function recordError(scope, error) {
    stats.errors += 1;
    errors.push({ scope, message: error?.message ?? String(error), error });
    console.error(`Fallout-MaW | Ошибка обновления: ${scope}`, error);
  }

  function isWorldPack(pack) {
    const packageType = String(pack.metadata?.packageType ?? pack.packageType ?? "");
    if (packageType === "world") return true;

    const packageName = String(pack.metadata?.packageName ?? pack.packageName ?? "");
    if (packageName && packageName === game.world?.id) return true;

    stats.skippedPacks += 1;
    return false;
  }
})();
