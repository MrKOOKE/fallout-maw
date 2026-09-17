const CLASS_RANKS = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });

/** Shared by the display list and the authoritative candidate filter. */
export function getHackingCandidateBlockReason({
  attemptsRemaining, toolClass, requiredClass, resourceConfigured = true, supplyValue, toolCost
}) {
  if (attemptsRemaining <= 0) return "Попытки метода исчерпаны";
  if ((CLASS_RANKS[toolClass] ?? 0) < (CLASS_RANKS[requiredClass] ?? 0)) return `Нужен класс ${requiredClass} или выше`;
  if (!resourceConfigured) return "Ресурс инструмента не настроен";
  if (supplyValue < toolCost) return `Недостаточно ресурса: нужно ${toolCost}, есть ${supplyValue}`;
  return "";
}

/** Presentation only: does not roll checks or mutate Foundry documents. */
export function buildHackingDialogState({
  methods = [], candidates = [], selectedMethodId = "", selectedCandidateKey = "",
  unlocked = false, isOwner = true, hasSkill = true, hasGM = true, targetAvailable = true, busy = ""
} = {}) {
  const firstAvailable = candidates.find(candidate => !candidate.blockReason);
  const selectedMethod = methods.find(method => method.id === selectedMethodId)
    ?? methods.find(method => method.id === firstAvailable?.methodId) ?? methods[0] ?? null;
  const methodTools = candidates.filter(candidate => candidate.methodId === selectedMethod?.id);
  const selectedTool = methodTools.find(candidate => candidate.candidateKey === selectedCandidateKey && !candidate.blockReason)
    ?? methodTools.find(candidate => !candidate.blockReason) ?? null;
  const methodCards = methods.map(method => {
    const tools = candidates.filter(candidate => candidate.methodId === method.id);
    const availableCount = tools.filter(tool => !tool.blockReason).length;
    const blockReason = method.attemptsRemaining <= 0 ? "Попытки исчерпаны"
      : availableCount ? "" : tools[0]?.blockReason || "Нет подходящих инструментов";
    return { ...method, selected: method.id === selectedMethod?.id, availableCount, blockReason };
  });
  const selectedCard = methodCards.find(method => method.selected);
  const blockReason = !targetAvailable ? "Объект больше недоступен"
    : unlocked ? "Замок уже вскрыт"
      : !isOwner ? "Нет прав на управление персонажем"
        : !hasSkill ? "У персонажа нет выбранного для взлома навыка"
          : !hasGM ? "Для взлома нужен активный ведущий"
            : !methods.length ? "Для объекта не настроены методы взлома"
              : selectedCard?.blockReason || (!selectedTool ? "Выберите доступный инструмент" : "");
  const exhausted = methods.length > 0 && methods.every(method => method.attemptsRemaining <= 0);
  return {
    isMechanical: selectedMethod?.interfaceType === "mechanical",
    methods: methodCards,
    selectedMethodId: selectedMethod?.id ?? "",
    selectedCandidateKey: selectedTool?.candidateKey ?? "",
    selectedMethod,
    selectedTool,
    methodCount: methods.length,
    hasMethods: methods.length > 0,
    tools: methodTools.map(tool => ({
      ...tool,
      selected: tool.candidateKey === selectedTool?.candidateKey,
      disabled: Boolean(busy || tool.blockReason),
      resourceLabel: tool.resourceMode === "condition" ? "Прочность" : "Запас",
      hasMeter: tool.supplyMax > 0,
      resourcePercent: tool.supplyMax > 0 ? Math.max(0, Math.min(100, 100 * tool.supplyValue / tool.supplyMax)) : 0
    })),
    hasTools: methodTools.length > 0,
    toolCount: methodTools.length,
    difficulty: selectedMethod?.difficulty ?? "—",
    requiredClass: selectedMethod?.toolClass ?? "—",
    attemptsRemaining: selectedMethod?.attemptsRemaining ?? 0,
    attemptsTotal: selectedMethod?.attempts ?? 0,
    attemptMarkers: selectedMethod && selectedMethod.attempts <= 10
      ? Array.from({ length: selectedMethod.attempts }, (_, index) => ({ remaining: index < selectedMethod.attemptsRemaining })) : [],
    resourceLabel: selectedTool?.resourceMode === "condition" ? "Прочность" : "Запас",
    remainingSupply: selectedTool ? Math.max(0, selectedTool.supplyValue - selectedTool.toolCost) : null,
    blockReason,
    busy: Boolean(busy),
    actionLabel: busy || (selectedMethod?.interfaceType === "mechanical" ? "Вскрыть замок" : "Взломать"),
    buttonLabel: busy ? "Выполняется…" : (selectedMethod?.interfaceType === "mechanical" ? "Вскрыть замок" : "Взломать"),
    hackDisabled: Boolean(busy || blockReason),
    statusLabel: !targetAvailable ? "Объект недоступен" : unlocked ? "Доступ получен" : exhausted ? "Попытки исчерпаны" : "Доступ закрыт",
    statusTone: !targetAvailable || exhausted ? "bad" : unlocked ? "ok" : "locked"
  };
}
