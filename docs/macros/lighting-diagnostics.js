/**
 * Fallout-MaW: диагностика освещения для Foundry VTT v14.
 *
 * Создайте макрос типа "Сценарий", вставьте этот файл целиком и запустите
 * на проблемной сцене от имени мастера. Макрос не изменяет документы мира.
 * Он один раз перестраивает runtime-источники света через PerceptionManager,
 * сравнивает результат до/после и предлагает скопировать или скачать JSON.
 */

const SYSTEM_ID = "fallout-maw";
const SYSTEM_ROOT = foundry.utils.getRoute("systems/fallout-maw");
const EPSILON = 0.01;
const DEFAULT_DIFFICULTY_THRESHOLDS = [1, 0.75, 0.5, 0.2, 0];

await runLightingDiagnostics();

async function runLightingDiagnostics() {
  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error("Этот макрос рассчитан на систему Fallout-MaW.");
    return;
  }
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.error("Сначала откройте и дождитесь загрузки проблемной сцены.");
    return;
  }

  ui.notifications.info("Fallout-MaW: собираю диагностику освещения…");

  try {
    const [
      lightingModule,
      environmentConditionsModule,
      stealthSettingsModule,
      dynamicLightingModule
    ] = await Promise.all([
      import(`${SYSTEM_ROOT}/src/stealth/lighting.mjs`),
      import(`${SYSTEM_ROOT}/src/abilities/environment-conditions.mjs`),
      import(`${SYSTEM_ROOT}/src/stealth/settings.mjs`),
      import(`${SYSTEM_ROOT}/src/time/dynamic-lighting.mjs`)
    ]);

    const modules = {
      ...lightingModule,
      ...environmentConditionsModule,
      ...stealthSettingsModule,
      ...dynamicLightingModule
    };

    resetSystemLightingCaches(modules);
    const beforeRefresh = captureRuntimeSnapshot(modules);

    // Runtime-only rebuild. No Scene, Token, Light, Region or Setting document is updated.
    canvas.perception.update({
      initializeLightSources: true,
      refreshLighting: true,
      refreshVision: true
    });
    await waitForCanvasFrames(3);

    resetSystemLightingCaches(modules);
    const afterRefresh = captureRuntimeSnapshot(modules);
    const report = buildReport({
      beforeRefresh,
      afterRefresh,
      modules
    });
    report.findings = buildFindings(report);

    console.group("Fallout-MaW | Lighting diagnostics");
    console.log(report);
    console.table(afterRefresh.tokens.map(token => ({
      token: token.name,
      illuminationPercent: token.systemAnalysis?.illuminationPercent,
      illuminationLevel: token.illuminationLevel,
      effectiveDarkness: token.systemAnalysis?.effectiveDarkness,
      rawDarkness: token.brightestPoint?.rawDarkness,
      globalLight: token.brightestPoint?.insideGlobalLight,
      localSources: token.brightestPoint?.localLightHits?.join(", ")
    })));
    console.groupEnd();

    showReportDialog(report);
    ui.notifications.info("Диагностика готова. Полный объект также выведен в консоль (F12).");
  } catch (error) {
    console.error("Fallout-MaW | Lighting diagnostics failed", error);
    ui.notifications.error(`Диагностика освещения завершилась ошибкой: ${error.message}`);
  }
}

function buildReport({ beforeRefresh, afterRefresh, modules }) {
  const worldTime = Number(game.time?.worldTime) || 0;
  const defaultStealthSettings = modules.createDefaultStealthSettings();
  const storedStealthSettings = readSetting(SYSTEM_ID, "stealthSettings");
  const normalizedStealthSettings = modules.normalizeStealthSettings(storedStealthSettings);
  const environment = cloneData(canvas.scene.environment);
  const worldHour = modulo(worldTime, 86400) / 3600;

  return {
    diagnostic: {
      name: "Fallout-MaW lighting diagnostics",
      version: 1,
      generatedAt: new Date().toISOString(),
      coreVersion: game.version,
      systemId: game.system.id,
      systemVersion: game.system.version,
      worldId: game.world?.id ?? "",
      worldTitle: game.world?.title ?? "",
      sceneId: canvas.scene.id,
      sceneName: canvas.scene.name
    },
    worldTime: {
      seconds: worldTime,
      day: Math.floor(worldTime / 86400),
      hour: round(worldHour, 4),
      clock: formatWorldClock(worldTime),
      falloutMawScheduledDarkness: round(modules.calculateWorldTimeDarkness(worldTime), 4)
    },
    scene: {
      tokenVision: Boolean(canvas.scene.tokenVision),
      environment,
      runtimeDarknessLevel: numberOrNull(canvas.environment?.darknessLevel),
      runtimeGlobalLight: summarizeLightSource(canvas.environment?.globalLightSource),
      ambientLights: Array.from(canvas.scene.lights ?? [], summarizeAmbientLight),
      darknessRegions: collectDarknessRegions(),
      darknessLevelMeshes: collectDarknessLevelMeshes()
    },
    stealthSettings: {
      stored: cloneData(storedStealthSettings),
      normalized: cloneData(normalizedStealthSettings),
      defaults: cloneData(defaultStealthSettings),
      difficultyThresholdsMatchDefaults: arraysEqual(
        normalizedStealthSettings.difficultyLevels.map(entry => Number(entry.threshold)),
        DEFAULT_DIFFICULTY_THRESHOLDS
      )
    },
    activeModules: Array.from(game.modules ?? [])
      .filter(module => module.active)
      .map(module => ({
        id: module.id,
        title: module.title,
        version: module.version
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    refreshTest: {
      changed: snapshotsDiffer(beforeRefresh, afterRefresh),
      before: beforeRefresh,
      after: afterRefresh
    },
    findings: []
  };
}

function captureRuntimeSnapshot(modules) {
  const sources = collectRuntimeSources();
  const tokens = Array.from(canvas.tokens?.placeables ?? [], token => inspectToken(token, modules, sources));
  return {
    capturedAt: new Date().toISOString(),
    canvasReady: Boolean(canvas.ready),
    runtimeDarknessLevel: numberOrNull(canvas.environment?.darknessLevel),
    globalLight: summarizeLightSource(canvas.environment?.globalLightSource),
    lightSources: sources.light.map(summarizeLightSource).sort(compareSourceIds),
    darknessSources: sources.darkness.map(summarizeLightSource).sort(compareSourceIds),
    lightingCache: modules.getLightingAnalysisCacheStats(),
    tokens
  };
}

function inspectToken(token, modules, sources) {
  const document = token.document;
  const points = getTokenTestPoints(token);
  const pointSamples = points.map(point => inspectPoint(point, modules, sources));
  const brightestPoint = pointSamples.reduce(
    (best, sample) => sample.systemAnalysis.effectiveDarkness < best.systemAnalysis.effectiveDarkness ? sample : best,
    pointSamples[0]
  );

  let systemAnalysis = null;
  let illuminationLevel = null;
  let error = null;
  try {
    systemAnalysis = modules.analyzeTokenLighting(token);
    illuminationLevel = token.actor
      ? modules.getActorIlluminationLevel(token.actor, { actorToken: token })
      : null;
  } catch (caught) {
    error = caught.message;
  }

  return {
    id: document.id,
    uuid: document.uuid,
    name: document.name,
    actorId: document.actorId ?? token.actor?.id ?? null,
    actorName: token.actor?.name ?? null,
    hidden: Boolean(document.hidden),
    position: {
      x: numberOrNull(document.x),
      y: numberOrNull(document.y),
      elevation: numberOrNull(document.elevation),
      level: document.level ?? null
    },
    tokenLight: cloneData(document.light),
    systemAnalysis: systemAnalysis ? roundLightingAnalysis(systemAnalysis) : null,
    illuminationLevel,
    brightestPoint,
    pointSamples,
    error
  };
}

function inspectPoint(point, modules, sources) {
  const rawDarkness = safeCall(() => canvas.effects.getDarknessLevel(point), null);
  const insideAnyLight = safeCall(() => canvas.effects.testInsideLight(point), false);
  const insideGlobalLight = safeCall(() => canvas.effects.testInsideLight(point, {
    condition: source => source === canvas.environment.globalLightSource
  }), false);
  const insideDarkness = safeCall(() => canvas.effects.testInsideDarkness(point), false);
  const localLightHits = sources.light
    .filter(source => source !== canvas.environment.globalLightSource)
    .filter(source => source.active && safeCall(() => source.testPoint(point), false))
    .map(source => source.sourceId ?? source.name ?? source.constructor?.name ?? "unknown")
    .sort();
  const darknessSourceHits = sources.darkness
    .filter(source => source.active && safeCall(() => source.testPoint(point), false))
    .map(source => source.sourceId ?? source.name ?? source.constructor?.name ?? "unknown")
    .sort();

  return {
    point: {
      x: round(point.x, 3),
      y: round(point.y, 3),
      elevation: round(point.elevation, 3)
    },
    rawDarkness: round(rawDarkness, 4),
    insideAnyLight,
    insideGlobalLight,
    insideDarkness,
    localLightHits,
    darknessSourceHits,
    systemAnalysis: roundLightingAnalysis(modules.analyzeLightingPoint(point))
  };
}

function collectRuntimeSources() {
  return {
    light: collectionValues(canvas.effects?.lightSources),
    darkness: collectionValues(canvas.effects?.darknessSources)
  };
}

function summarizeLightSource(source) {
  if (!source) return null;
  const data = source.data ?? {};
  const origin = source.origin ?? source;
  const object = source.object;
  const document = object?.document;
  return {
    sourceId: source.sourceId ?? source.name ?? "",
    className: source.constructor?.name ?? "",
    objectType: document?.documentName ?? object?.constructor?.name ?? "",
    objectId: document?.id ?? null,
    objectName: document?.name ?? object?.name ?? null,
    active: Boolean(source.active),
    attached: Boolean(source.attached),
    suppressed: Boolean(source.suppressed),
    disabled: Boolean(data.disabled),
    isPreview: Boolean(source.isPreview),
    position: {
      x: numberOrNull(origin.x),
      y: numberOrNull(origin.y),
      elevation: numberOrNull(origin.elevation),
      level: data.level ?? null
    },
    brightPixels: numberOrNull(data.bright),
    dimPixels: numberOrNull(data.dim),
    radiusPixels: numberOrNull(data.radius),
    priority: numberOrNull(data.priority ?? source.priority),
    darknessRange: {
      min: numberOrNull(data.darkness?.min),
      max: numberOrNull(data.darkness?.max)
    },
    negative: Boolean(data.negative),
    walls: data.walls ?? null,
    luminosity: numberOrNull(data.luminosity),
    updateId: numberOrNull(source.updateId)
  };
}

function summarizeAmbientLight(light) {
  const object = light.object;
  return {
    id: light.id,
    uuid: light.uuid,
    name: light.name,
    x: numberOrNull(light.x),
    y: numberOrNull(light.y),
    elevation: numberOrNull(light.elevation),
    hidden: Boolean(light.hidden),
    walls: Boolean(light.walls),
    isGlobalShape: Boolean(light.isGlobal),
    levels: Array.from(light.levels ?? []),
    config: cloneData(light.config),
    runtimeSource: summarizeLightSource(object?.lightSource)
  };
}

function collectDarknessRegions() {
  const entries = [];
  for (const region of canvas.scene.regions ?? []) {
    for (const behavior of region.behaviors ?? []) {
      if (behavior.type !== "adjustDarknessLevel") continue;
      entries.push({
        regionId: region.id,
        regionName: region.name,
        regionHidden: Boolean(region.hidden),
        behaviorId: behavior.id,
        behaviorName: behavior.name,
        behaviorDisabled: Boolean(behavior.disabled),
        behaviorViewed: Boolean(behavior.viewed),
        system: cloneData(behavior.system),
        elevation: cloneData(region.elevation),
        levels: Array.from(region.levels ?? [])
      });
    }
  }
  return entries;
}

function collectDarknessLevelMeshes() {
  return Array.from(canvas.effects?.illumination?.darknessLevelMeshes?.children ?? [], mesh => ({
    name: mesh.name ?? "",
    darknessLevel: numberOrNull(mesh.shader?.uniforms?.darknessLevel ?? mesh.shader?.darknessLevel),
    mode: numberOrNull(mesh.shader?.mode),
    modifier: numberOrNull(mesh.shader?.modifier),
    regionId: mesh.region?.document?.id ?? null,
    regionName: mesh.region?.document?.name ?? null
  }));
}

function buildFindings(report) {
  const findings = [];
  const before = report.refreshTest.before;
  const after = report.refreshTest.after;
  const tokens = after.tokens.filter(token => !token.error && token.systemAnalysis);
  const actorTokens = tokens.filter(token => token.actorId && token.illuminationLevel);
  const allMaximum = tokens.length > 0
    && tokens.every(token => token.systemAnalysis.illuminationPercent >= 99);
  const allNormalLevel = actorTokens.length > 0
    && actorTokens.every(token => token.illuminationLevel === "normal");
  const sceneDarkness = Number(report.scene.environment?.darknessLevel);
  const runtimeDarkness = Number(report.scene.runtimeDarknessLevel);
  const scheduledDarkness = Number(report.worldTime.falloutMawScheduledDarkness);
  const globalEnabled = Boolean(report.scene.environment?.globalLight?.enabled);
  const globalActive = Boolean(after.globalLight?.active);
  const commonLocalSources = intersectArrays(tokens.map(token => token.brightestPoint?.localLightHits ?? []));
  const rawDarknessValues = tokens.map(token => Number(token.brightestPoint?.rawDarkness));

  if (!tokens.length) {
    findings.push(finding("warn", "На сцене нет доступных токенов для проверки."));
    return findings;
  }

  if (report.refreshTest.changed) {
    findings.push(finding(
      "error",
      "Принудительная перестройка Perception изменила результат. До запуска Canvas содержал устаревшие runtime-источники или кэш."
    ));
  }

  if (Number.isFinite(sceneDarkness) && Number.isFinite(runtimeDarkness)
    && Math.abs(sceneDarkness - runtimeDarkness) > EPSILON) {
    findings.push(finding(
      "error",
      `Документ сцены хранит темноту ${round(sceneDarkness, 3)}, а Canvas показывает ${round(runtimeDarkness, 3)}.`
    ));
  }

  if (globalEnabled || globalActive) {
    findings.push(finding(
      allMaximum ? "error" : "warn",
      `Глобальное освещение сцены: настройка=${globalEnabled ? "включена" : "выключена"}, runtime=${globalActive ? "активен" : "неактивен"}.`
    ));
  }

  if (commonLocalSources.length) {
    findings.push(finding(
      allMaximum ? "error" : "warn",
      `Один и тот же локальный источник покрывает самые светлые точки всех токенов: ${commonLocalSources.join(", ")}.`
    ));
  }

  if (allMaximum && rawDarknessValues.every(value => value <= EPSILON)) {
    const regionMismatch = runtimeDarkness > EPSILON;
    findings.push(finding(
      "error",
      regionMismatch
        ? "В самых светлых точках всех токенов темнота принудительно равна 0, хотя общая темнота сцены выше. Проверьте регионы «Изменить уровень темноты»."
        : "Базовая темнота во всех проверенных точках равна 0 — Fallout-MaW закономерно получает 100% освещения даже без ламп."
    ));
  }

  if (scheduledDarkness <= EPSILON && !report.scene.environment?.darknessLock) {
    findings.push(finding(
      allMaximum ? "error" : "info",
      `Мировое время ${report.worldTime.clock} попадает в дневную часть расписания Fallout-MaW; система целится в темноту ${scheduledDarkness}.`
    ));
  } else if (scheduledDarkness <= EPSILON) {
    findings.push(finding(
      "info",
      `По мировому времени целевая темнота равна ${scheduledDarkness}, но автоматическое изменение заблокировано настройкой сцены darknessLock.`
    ));
  } else if (Math.abs(scheduledDarkness - runtimeDarkness) > EPSILON
    && !report.scene.environment?.darknessLock) {
    findings.push(finding(
      "warn",
      `По мировому времени ожидается темнота ${scheduledDarkness}, но Canvas показывает ${round(runtimeDarkness, 3)}.`
    ));
  }

  if (!report.stealthSettings.difficultyThresholdsMatchDefaults) {
    const thresholds = report.stealthSettings.normalized.difficultyLevels
      .map(entry => entry.threshold)
      .join(", ");
    findings.push(finding(
      allNormalLevel ? "error" : "warn",
      `Пороги уровней света изменены относительно штатных [${DEFAULT_DIFFICULTY_THRESHOLDS.join(", ")}]: сейчас [${thresholds}].`
    ));
  }

  if (allNormalLevel && !allMaximum) {
    findings.push(finding(
      "error",
      "Система измеряет не максимальную освещённость, но всем токенам присваивает уровень «Обычный свет». Причина почти наверняка в изменённых порогах настроек скрытности."
    ));
  }

  if (allMaximum && !globalEnabled && !globalActive && !commonLocalSources.length
    && rawDarknessValues.some(value => value > EPSILON)) {
    findings.push(finding(
      "warn",
      "У всех токенов 100% освещения, но причины различаются по позициям. Смотрите localLightHits у каждого токена в JSON."
    ));
  }

  if (!allMaximum && !allNormalLevel) {
    findings.push(finding(
      "ok",
      "После перестройки Canvas освещённость и уровни света различаются между проверенными токенами."
    ));
  } else if (allMaximum) {
    findings.push(finding("error", "Проблема воспроизведена: все проверенные токены имеют 99–100% освещения."));
  }

  if (!snapshotsDiffer(before, after)) {
    findings.push(finding("info", "Перестройка Perception не изменила измерения: это не простой зависший runtime-кэш."));
  }
  return findings;
}

function showReportDialog(report) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const json = JSON.stringify(report, null, 2);
  const rows = report.refreshTest.after.tokens.map(token => {
    const analysis = token.systemAnalysis ?? {};
    return `
      <tr>
        <td>${escapeHtml(token.name)}</td>
        <td>${escapeHtml(analysis.illuminationPercent ?? "—")}%</td>
        <td>${escapeHtml(token.illuminationLevel ?? "—")}</td>
        <td>${escapeHtml(analysis.effectiveDarkness ?? "—")}</td>
        <td>${escapeHtml(token.brightestPoint?.rawDarkness ?? "—")}</td>
        <td>${escapeHtml(token.brightestPoint?.insideGlobalLight ? "да" : "нет")}</td>
        <td>${escapeHtml((token.brightestPoint?.localLightHits ?? []).join(", ") || "—")}</td>
      </tr>
    `;
  }).join("");
  const findings = report.findings.map(entry => `
    <li style="margin-bottom: 0.35rem;">
      <strong>${escapeHtml(findingLabel(entry.severity))}:</strong>
      ${escapeHtml(entry.message)}
    </li>
  `).join("");
  const content = `
    <div style="display:flex; flex-direction:column; gap:0.75rem; max-height:70vh; overflow:auto;">
      <p style="margin:0;">
        <strong>Сцена:</strong> ${escapeHtml(report.diagnostic.sceneName)}
        · <strong>время:</strong> ${escapeHtml(report.worldTime.clock)}
        · <strong>темнота Canvas:</strong> ${escapeHtml(report.scene.runtimeDarknessLevel)}
        · <strong>цель по времени:</strong> ${escapeHtml(report.worldTime.falloutMawScheduledDarkness)}
      </p>
      <ul style="margin:0; padding-left:1.25rem;">${findings}</ul>
      <table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
        <thead>
          <tr>
            <th>Токен</th>
            <th>Свет</th>
            <th>Уровень</th>
            <th>Эфф. тьма</th>
            <th>Сырая тьма</th>
            <th>Глоб.</th>
            <th>Локальные источники</th>
          </tr>
        </thead>
        <tbody>${rows || "<tr><td colspan='7'>Токены не найдены.</td></tr>"}</tbody>
      </table>
      <details>
        <summary>JSON-отчёт</summary>
        <textarea readonly style="width:100%; min-height:16rem; font-family:monospace; font-size:0.75rem;">${escapeHtml(json)}</textarea>
      </details>
    </div>
  `;

  new DialogV2({
    window: {
      title: "Fallout-MaW — диагностика освещения",
      resizable: true
    },
    position: {
      width: 1000,
      height: "auto"
    },
    content,
    buttons: [
      {
        action: "copy",
        label: "Копировать JSON",
        icon: "fa-solid fa-copy",
        callback: async () => {
          await navigator.clipboard.writeText(json);
          ui.notifications.info("JSON-отчёт скопирован в буфер обмена.");
        }
      },
      {
        action: "download",
        label: "Скачать JSON",
        icon: "fa-solid fa-download",
        callback: () => {
          const filename = `fallout-maw-lighting-${sanitizeFilename(canvas.scene.name)}-${Date.now()}.json`;
          foundry.utils.saveDataToFile(json, "application/json", filename);
        }
      },
      {
        action: "close",
        label: "Закрыть",
        icon: "fa-solid fa-xmark",
        default: true
      }
    ]
  }).render({ force: true });
}

function getTokenTestPoints(token) {
  const document = token.document ?? token;
  const points = safeCall(() => document.getVisibilityTestPoints(), null);
  if (Array.isArray(points) && points.length) {
    return points.map(point => normalizePoint(point, document.elevation));
  }
  const center = safeCall(() => document.getCenterPoint(), null) ?? token.center ?? {
    x: Number(document.x) || 0,
    y: Number(document.y) || 0
  };
  return [normalizePoint(center, document.elevation)];
}

function normalizePoint(point, elevation = 0) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    elevation: Number(point?.elevation ?? elevation) || 0
  };
}

function resetSystemLightingCaches(modules) {
  modules.invalidateLightingAnalysisCache();
  modules.invalidateAbilityConditionLightingCache();
}

function snapshotsDiffer(left, right) {
  const stableSource = source => {
    const { updateId: _updateId, ...stable } = source ?? {};
    return stable;
  };
  const compact = snapshot => JSON.stringify({
    runtimeDarknessLevel: snapshot.runtimeDarknessLevel,
    globalLight: stableSource(snapshot.globalLight),
    lightSources: snapshot.lightSources.map(stableSource),
    darknessSources: snapshot.darknessSources.map(stableSource),
    tokens: snapshot.tokens.map(token => ({
      id: token.id,
      systemAnalysis: token.systemAnalysis,
      illuminationLevel: token.illuminationLevel,
      brightestPoint: token.brightestPoint
    }))
  });
  return compact(left) !== compact(right);
}

function roundLightingAnalysis(value) {
  return {
    baseDarkness: round(value?.baseDarkness, 4),
    effectiveDarkness: round(value?.effectiveDarkness, 4),
    lightIntensity: round(value?.lightIntensity, 4),
    darknessLabel: value?.darknessLabel ?? null,
    darknessPercent: numberOrNull(value?.darknessPercent),
    illuminationPercent: numberOrNull(value?.illuminationPercent)
  };
}

function collectionValues(collection) {
  if (!collection) return [];
  try {
    return Array.from(typeof collection.values === "function" ? collection.values() : collection);
  } catch (_error) {
    return [];
  }
}

function compareSourceIds(left, right) {
  return String(left?.sourceId ?? "").localeCompare(String(right?.sourceId ?? ""));
}

function cloneData(value) {
  if (value === null || value === undefined) return value;
  if (typeof value.toObject === "function") return value.toObject();
  try {
    return foundry.utils.deepClone(value);
  } catch (_error) {
    return JSON.parse(JSON.stringify(value));
  }
}

function readSetting(namespace, key) {
  try {
    return game.settings.get(namespace, key);
  } catch (error) {
    return { diagnosticReadError: error.message };
  }
}

function finding(severity, message) {
  return { severity, message };
}

function findingLabel(severity) {
  return {
    ok: "Норма",
    info: "Информация",
    warn: "Проверить",
    error: "Вероятная причина"
  }[severity] ?? severity;
}

function intersectArrays(arrays) {
  if (!arrays.length) return [];
  return [...new Set(arrays[0])].filter(value => arrays.every(array => array.includes(value)));
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatWorldClock(worldTime) {
  const seconds = modulo(Math.floor(Number(worldTime) || 0), 86400);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function waitForCanvasFrames(count = 1) {
  return new Promise(resolve => {
    const next = remaining => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      globalThis.requestAnimationFrame(() => next(remaining - 1));
    };
    next(Math.max(1, Number(count) || 1));
  });
}

function safeCall(callback, fallback) {
  try {
    return callback();
  } catch (_error) {
    return fallback;
  }
}

function round(value, places = 4) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** places;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sanitizeFilename(value) {
  return String(value ?? "scene")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "scene";
}
