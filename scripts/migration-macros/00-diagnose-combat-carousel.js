/**
 * Fallout-MaW: диагностика потерянной привязки боевой карусели.
 *
 * Создайте в Foundry макрос типа "Сценарий", вставьте весь файл и запустите
 * его у пользователя, у которого карусель стала плавающим окном.
 * Макрос только читает состояние клиента и мира. Он ничего не исправляет.
 */
(async () => {
  const SYSTEM_ID = "fallout-maw";
  const DIRECTION_KEY = `${SYSTEM_ID}.direction`;
  const POSITION_KEY = `${SYSTEM_ID}.combat-dock-position`;
  const DOCKED_DIRECTION = "rowDocked";
  const reportVersion = 1;

  const safely = (callback, fallback = null) => {
    try {
      return callback();
    } catch (error) {
      return {
        error: String(error?.message ?? error)
      };
    }
  };

  const cloneForReport = value => {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_error) {
      return String(value);
    }
  };

  const readStorageValue = (storage, key) => {
    if (!storage) return null;
    if (typeof storage.get === "function") return safely(() => storage.get(key));
    if (typeof storage.getItem === "function") return safely(() => storage.getItem(key));
    if (typeof storage.settings?.get === "function") return safely(() => storage.settings.get(key));
    return {
      unsupportedStorage: storage?.constructor?.name ?? typeof storage
    };
  };

  const roundRect = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return Object.fromEntries(
      ["x", "y", "top", "right", "bottom", "left", "width", "height"]
        .map(key => [key, Math.round(rect[key] * 100) / 100])
    );
  };

  const describeElement = element => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      tag: element.tagName?.toLowerCase() ?? "",
      id: element.id ?? "",
      classes: Array.from(element.classList ?? []),
      parent: element.parentElement
        ? `${element.parentElement.tagName.toLowerCase()}#${element.parentElement.id}.${Array.from(element.parentElement.classList).join(".")}`
        : null,
      inlineStyle: element.getAttribute("style") ?? "",
      rect: roundRect(element),
      computed: {
        display: style.display,
        position: style.position,
        inset: style.inset,
        top: style.top,
        right: style.right,
        bottom: style.bottom,
        left: style.left,
        width: style.width,
        height: style.height,
        maxWidth: style.maxWidth,
        maxHeight: style.maxHeight,
        flex: style.flex,
        flexDirection: style.flexDirection,
        justifyContent: style.justifyContent,
        alignItems: style.alignItems,
        transform: style.transform,
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex,
        visibility: style.visibility,
        opacity: style.opacity
      }
    };
  };

  const parentChain = element => {
    const chain = [];
    for (let current = element; current && chain.length < 12; current = current.parentElement) {
      chain.push(`${current.tagName.toLowerCase()}${current.id ? `#${current.id}` : ""}${
        current.classList?.length ? `.${Array.from(current.classList).join(".")}` : ""
      }`);
    }
    return chain;
  };

  const collectMatchingCssRules = targets => {
    const found = [];
    const interestingProperties = new Set([
      "display", "position", "inset", "top", "right", "bottom", "left",
      "width", "height", "max-width", "max-height", "flex", "flex-direction",
      "justify-content", "align-items", "transform", "z-index", "visibility",
      "opacity", "pointer-events"
    ]);

    const visitRules = (rules, source, scope = "") => {
      for (const rule of Array.from(rules ?? [])) {
        if (rule.cssRules) {
          visitRules(rule.cssRules, source, `${scope}${rule.conditionText ? ` @${rule.conditionText}` : ""}`);
          continue;
        }
        if (!rule.selectorText || !rule.style) continue;

        const matchedTargets = targets
          .filter(([, element]) => element)
          .filter(([, element]) => safely(() => element.matches(rule.selectorText), false))
          .map(([name]) => name);
        if (!matchedTargets.length) continue;

        const declarations = {};
        for (const property of Array.from(rule.style)) {
          if (!interestingProperties.has(property)) continue;
          declarations[property] = rule.style.getPropertyValue(property).trim()
            + (rule.style.getPropertyPriority(property) ? " !important" : "");
        }
        if (!Object.keys(declarations).length) continue;

        found.push({
          targets: matchedTargets,
          selector: rule.selectorText,
          source,
          scope: scope.trim(),
          declarations
        });
        if (found.length >= 150) return;
      }
    };

    for (const sheet of Array.from(document.styleSheets ?? [])) {
      if (found.length >= 150) break;
      const source = sheet.href ?? "<inline style>";
      try {
        visitRules(sheet.cssRules, source);
      } catch (error) {
        found.push({ source, unreadable: String(error?.message ?? error) });
      }
    }
    return found;
  };

  const directionRegistered = game.settings.settings.has(DIRECTION_KEY);
  const direction = directionRegistered
    ? safely(() => game.settings.get(SYSTEM_ID, "direction"))
    : null;
  const expectedDocked = direction === DOCKED_DIRECTION;

  const dockApp = ui.combatDock ?? null;
  const dockRoot = dockApp?.element ?? document.querySelector("#combat-dock");
  const dockContent = dockRoot?.querySelector(":scope > .window-content") ?? null;
  const dockInner = dockRoot?.querySelector(".combat-dock") ?? null;
  const windowHeader = dockRoot?.querySelector(":scope > .window-header") ?? null;
  const uiTop = document.querySelector("#ui-top");
  const uiMiddle = document.querySelector("#ui-middle");

  const settingDefinition = game.settings.settings.get(DIRECTION_KEY) ?? null;
  const positionDefinition = game.settings.settings.get(POSITION_KEY) ?? null;
  const worldStorage = game.settings.storage.get("world");
  const clientStorage = game.settings.storage.get("client");
  const storedDirectionDocument = readStorageValue(worldStorage, DIRECTION_KEY);
  const storedPositionDocument = readStorageValue(clientStorage, POSITION_KEY);

  const classDefaults = safely(() => cloneForReport(CONFIG.combatTrackerDock?.CombatDock?.DEFAULT_OPTIONS));
  const appOptions = cloneForReport(dockApp?.options ?? null);
  const headerStyle = windowHeader ? getComputedStyle(windowHeader) : null;

  const findings = [];
  const addFinding = (severity, code, message) => findings.push({ severity, code, message });

  if (game.system.id !== SYSTEM_ID) {
    addFinding("ERROR", "WRONG_SYSTEM", `Активна система ${game.system.id}, ожидалась ${SYSTEM_ID}.`);
  }
  if (!directionRegistered) {
    addFinding("ERROR", "DIRECTION_NOT_REGISTERED", `Настройка ${DIRECTION_KEY} не зарегистрирована.`);
  } else if (!expectedDocked) {
    addFinding(
      "ROOT_CAUSE",
      "FLOATING_DIRECTION_SELECTED",
      `direction = ${JSON.stringify(direction)}. Только ${JSON.stringify(DOCKED_DIRECTION)} закрепляет карусель сверху; остальные значения намеренно создают перетаскиваемое окно.`
    );
  }

  if (!dockRoot) {
    addFinding(
      game.combat ? "ERROR" : "INFO",
      "DOCK_NOT_RENDERED",
      game.combat
        ? "Есть активный бой, но #combat-dock не найден. Возможна ошибка рендера — нужен текст ошибки из консоли."
        : "#combat-dock не найден, но активного боя тоже нет. Запустите диагностику во время боя."
    );
  } else {
    if (expectedDocked && dockRoot.parentElement !== uiTop) {
      addFinding(
        "ROOT_CAUSE",
        "DOCK_NOT_ATTACHED_TO_UI_TOP",
        `Настройка требует верхнюю привязку, но родитель карусели — ${dockRoot.parentElement?.id || dockRoot.parentElement?.tagName || "null"}, а не #ui-top.`
      );
    }
    if (!expectedDocked && dockRoot.parentElement === uiTop) {
      addFinding(
        "WARNING",
        "FLOATING_DOCK_ATTACHED_TO_UI_TOP",
        "Выбран плавающий режим, но элемент остался внутри #ui-top. Вероятно, экземпляр не перезапустился после смены настройки."
      );
    }

    const frameEnabled = Boolean(appOptions?.window?.frame);
    const positionedEnabled = Boolean(appOptions?.window?.positioned);
    const headerVisible = Boolean(windowHeader && headerStyle?.display !== "none" && headerStyle?.visibility !== "hidden");
    if (expectedDocked && (frameEnabled || positionedEnabled || headerVisible)) {
      addFinding(
        "ROOT_CAUSE",
        "STALE_FLOATING_APPLICATION_OPTIONS",
        `direction уже равен ${DOCKED_DIRECTION}, но живой экземпляр всё ещё оконный: frame=${frameEnabled}, positioned=${positionedEnabled}, visibleHeader=${headerVisible}. Настройка и экземпляр рассинхронизированы.`
      );
    }

    const inlinePosition = dockRoot.style.position;
    const inlineCoordinates = [dockRoot.style.left, dockRoot.style.top, dockRoot.style.right, dockRoot.style.bottom].filter(Boolean);
    if (expectedDocked && (inlinePosition === "absolute" || inlinePosition === "fixed" || inlineCoordinates.length)) {
      addFinding(
        "WARNING",
        "DOCK_HAS_INLINE_POSITION",
        `У закреплённой карусели остались inline-координаты: ${dockRoot.getAttribute("style") || "(пусто)"}. Возможно, применена сохранённая позиция плавающего режима.`
      );
    }
  }

  const moduleDocuments = game.modules?.values
    ? Array.from(game.modules.values())
    : Array.from(game.modules ?? []).map(entry => Array.isArray(entry) ? entry[1] : entry);
  const activeModules = moduleDocuments
    .filter(module => module?.active)
    .map(module => ({
      id: module.id ?? module.manifest?.id ?? "unknown",
      version: module.version ?? module.manifest?.version ?? null
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const report = {
    report: "Fallout-MaW combat carousel attachment diagnostics",
    reportVersion,
    generatedAt: new Date().toISOString(),
    verdict: findings,
    environment: {
      foundryVersion: game.version,
      foundryBuild: game.release?.build ?? null,
      systemId: game.system.id,
      systemVersion: game.system.version,
      worldId: game.world?.id ?? null,
      userIsGM: Boolean(game.user?.isGM),
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      uiScale: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(),
      activeModules
    },
    settings: {
      direction: {
        key: DIRECTION_KEY,
        registered: directionRegistered,
        value: cloneForReport(direction),
        expectedDocked,
        definition: settingDefinition ? {
          scope: settingDefinition.scope,
          default: cloneForReport(settingDefinition.default),
          type: settingDefinition.type?.name ?? String(settingDefinition.type ?? "")
        } : null,
        storedDocument: cloneForReport(storedDirectionDocument?.toObject?.() ?? storedDirectionDocument)
      },
      savedPosition: {
        key: POSITION_KEY,
        registered: Boolean(positionDefinition),
        value: positionDefinition ? safely(() => cloneForReport(game.settings.get(SYSTEM_ID, "combat-dock-position"))) : null,
        storedDocument: cloneForReport(storedPositionDocument?.toObject?.() ?? storedPositionDocument)
      }
    },
    application: {
      exists: Boolean(dockApp),
      className: dockApp?.constructor?.name ?? null,
      appId: dockApp?.id ?? null,
      rendered: dockApp?.rendered ?? null,
      closedFlag: dockApp?._closed ?? null,
      position: cloneForReport(dockApp?.position ?? null),
      options: appOptions,
      currentClassDefaults: classDefaults,
      staticPositionSettingRegistered: CONFIG.combatTrackerDock?.CombatDock?.POSITION_SETTING_REGISTERED ?? null
    },
    dom: {
      dockRoot: describeElement(dockRoot),
      dockContent: describeElement(dockContent),
      dockInner: describeElement(dockInner),
      windowHeader: describeElement(windowHeader),
      uiTop: describeElement(uiTop),
      uiMiddle: describeElement(uiMiddle),
      dockParentChain: parentChain(dockRoot),
      dockIsDirectChildOfUiTop: Boolean(dockRoot && dockRoot.parentElement === uiTop),
      windowHeaderExists: Boolean(windowHeader),
      combatantCount: dockRoot?.querySelectorAll("#combatants > .combatant-portrait")?.length ?? 0
    },
    css: {
      rootVariables: {
        carouselDirection: getComputedStyle(document.documentElement).getPropertyValue("--carousel-direction").trim(),
        carouselFloatingSize: getComputedStyle(document.documentElement).getPropertyValue("--carousel-floating-size").trim(),
        carouselAlignment: getComputedStyle(document.documentElement).getPropertyValue("--carousel-alignment").trim(),
        carouselAlignItems: getComputedStyle(document.documentElement).getPropertyValue("--carousel-align-items").trim(),
        portraitSize: getComputedStyle(document.documentElement).getPropertyValue("--combatant-portrait-size").trim()
      },
      matchingLayoutRules: collectMatchingCssRules([
        ["dockRoot", dockRoot],
        ["dockInner", dockInner],
        ["windowHeader", windowHeader],
        ["uiTop", uiTop],
        ["uiMiddle", uiMiddle]
      ])
    }
  };

  const reportText = JSON.stringify(report, null, 2);
  globalThis.FALLOUT_MAW_CAROUSEL_DIAGNOSTICS = report;

  console.group("Fallout-MaW | Combat carousel diagnostics");
  console.table(findings);
  console.log(report);
  console.log(reportText);
  console.groupEnd();

  const escapeHTML = value => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const verdictHtml = findings.length
    ? findings.map(finding => `<li><strong>${escapeHTML(finding.severity)} · ${escapeHTML(finding.code)}</strong><br>${escapeHTML(finding.message)}</li>`).join("")
    : "<li><strong>OK</strong> — явная рассинхронизация не обнаружена; пришлите полный отчёт.</li>";

  const { DialogV2 } = foundry.applications.api;
  await DialogV2.wait({
    window: {
      title: "Диагностика боевой карусели",
      icon: "fa-solid fa-stethoscope"
    },
    position: { width: 760, height: 720 },
    content: `
      <div class="fallout-maw-carousel-diagnostics" style="display:flex; flex-direction:column; gap:0.75rem; height:100%;">
        <p style="margin:0;">Макрос ничего не изменил. Скопируйте отчёт и отправьте разработчику.</p>
        <ol style="margin:0; padding-left:1.5rem; max-height:11rem; overflow:auto;">${verdictHtml}</ol>
        <button type="button" data-copy-carousel-report>
          <i class="fa-solid fa-copy"></i> Скопировать полный отчёт
        </button>
        <textarea readonly data-carousel-report style="flex:1; min-height:360px; resize:none; font-family:monospace; font-size:11px; white-space:pre;">${escapeHTML(reportText)}</textarea>
      </div>
    `,
    render: (_event, dialog) => {
      const root = dialog.element;
      const button = root.querySelector("[data-copy-carousel-report]");
      const textarea = root.querySelector("[data-carousel-report]");
      button?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(reportText);
          ui.notifications.info("Отчёт диагностики скопирован в буфер обмена.");
        } catch (error) {
          textarea?.focus();
          textarea?.select();
          ui.notifications.warn("Автокопирование недоступно. Текст отчёта выделен — нажмите Ctrl+C.");
          console.warn("Fallout-MaW | Clipboard copy failed", error);
        }
      });
    },
    buttons: [{ action: "close", label: "Закрыть", icon: "fa-solid fa-xmark" }],
    rejectClose: false
  });
})();
