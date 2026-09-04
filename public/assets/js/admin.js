/**
 * Painel de administracao do board de cronometros.
 *
 * O board e reconstruido apenas quando a lista de cronometros muda (entrou,
 * saiu ou trocou de posicao). A cada tick de 250ms so os textos, classes e
 * larguras sao atualizados, para nao derrubar o foco de quem esta digitando o
 * titulo de um cronometro nem recriar 12 cards quatro vezes por segundo.
 */
(() => {
  const {
    MAX_TIMERS_PER_SESSION,
    MAX_TIMER_MS,
    formatCompactDuration,
    formatTime,
    getDisplayMs,
    getPhase,
    getTimerLabel,
    getTimerMetaLabel,
    isValidAdminToken,
    isValidSessionId,
    sanitizeSessionState,
    sanitizeTimerName,
    splitDuration,
  } = window.CronoUtils;

  const MODELS_KEY = "crono_sw_models";
  const MAX_MODELS = 20;
  const MAX_TIMER_HOURS = Math.floor(MAX_TIMER_MS / 3600000);
  // Um reset descarta a contagem: so pedimos confirmacao quando ha tempo
  // suficiente acumulado para que perder seja realmente um prejuizo.
  const RESET_CONFIRM_MS = 60 * 1000;
  const FEEDBACK_TIMEOUT_MS = 2600;

  const socket = io();
  const sessionId = window.location.pathname.split("/").pop();
  const adminToken = window.location.hash.slice(1);
  const legacyPresetsKey = `crono_sw_presets_${sessionId}`;

  const elements = {
    adminPanel: document.getElementById("admin-panel"),
    board: document.getElementById("timer-board"),
    boardEmpty: document.getElementById("board-empty"),
    boardFeedback: document.getElementById("board-feedback"),
    cardTemplate: document.getElementById("timer-card-template"),
    sessionLabel: document.getElementById("session-label"),
    timerCount: document.getElementById("timer-count"),
    addTimer: document.getElementById("btn-add-timer"),
    startAll: document.getElementById("btn-start-all"),
    pauseAll: document.getElementById("btn-pause-all"),
    resetAll: document.getElementById("btn-reset-all"),
    fullscreen: document.getElementById("btn-fullscreen"),
    openSettings: document.getElementById("btn-open-settings"),
    closeSettings: document.getElementById("btn-close-settings"),
    settingsOverlay: document.getElementById("settings-overlay"),
    modelsChips: document.getElementById("models-chips"),
    modelsManage: document.getElementById("models-manage"),
    modelName: document.getElementById("model-name"),
    modelHours: document.getElementById("model-h"),
    modelMinutes: document.getElementById("model-m"),
    modelSeconds: document.getElementById("model-s"),
    modelDirection: document.getElementById("model-direction"),
    addModel: document.getElementById("btn-add-model"),
    modelFeedback: document.getElementById("model-feedback"),
    viewerLinks: document.querySelectorAll(".viewer-direct-link"),
  };

  const cards = new Map();
  const expandedTimers = new Set();
  const finishWatchers = new Map();

  let state = { timers: [], primaryTimerId: null };
  let boardSignature = null;
  let pendingFocusTimerId = null;
  let boardFeedbackTimer = 0;
  let modelFeedbackTimer = 0;

  if (
    !elements.adminPanel ||
    !elements.board ||
    !elements.cardTemplate ||
    !isValidSessionId(sessionId)
  ) {
    showError("Sessão não encontrada.");
    return;
  }

  if (!isValidAdminToken(adminToken)) {
    showError("Acesso de admin inválido ou expirado.");
    return;
  }

  bindEvents();
  connectToSession();

  // ------------------------------------------------------------- ciclo base

  function connectToSession() {
    socket.emit("session:join", sessionId, "admin", adminToken, (response) => {
      if (!response?.success) {
        showError(
          response?.reason === "unauthorized"
            ? "Acesso de admin inválido ou expirado."
            : "Sessão não encontrada.",
        );
        return;
      }

      elements.adminPanel.style.display = "block";

      if (elements.sessionLabel) {
        elements.sessionLabel.textContent = sessionId;
      }

      for (const link of elements.viewerLinks) {
        link.href = `/view/${sessionId}`;
      }

      renderModels();
      syncFullscreenButton();
    });
  }

  function bindEvents() {
    socket.on("session:state", applyState);
    socket.on("connect_error", () => {
      showError("Não foi possível conectar ao servidor.");
    });
    socket.on("session:closed", () => {
      showError("Sessão encerrada.");
    });

    elements.board.addEventListener("click", onBoardClick);
    elements.board.addEventListener("change", onBoardChange);
    elements.board.addEventListener("keydown", onBoardKeydown);

    elements.addTimer?.addEventListener("click", () => addTimer());
    elements.startAll?.addEventListener("click", () => bulkAction("start"));
    elements.pauseAll?.addEventListener("click", () => bulkAction("pause"));
    elements.resetAll?.addEventListener("click", () => bulkAction("reset"));

    elements.fullscreen?.addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", syncFullscreenButton);

    elements.openSettings?.addEventListener("click", openSettings);
    elements.closeSettings?.addEventListener("click", closeSettings);
    elements.settingsOverlay?.addEventListener("click", (event) => {
      if (event.target === elements.settingsOverlay) {
        closeSettings();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSettings();
      }
    });

    elements.addModel?.addEventListener("click", addModelFromForm);
    elements.modelName?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addModelFromForm();
      }
    });
    elements.modelName?.addEventListener("input", () => {
      showModelFeedback("", "");
    });
  }

  function applyState(raw) {
    state = sanitizeSessionState(raw);

    const signature = state.timers.map((timer) => timer.id).join(",");
    if (signature !== boardSignature) {
      rebuildCards();
      boardSignature = signature;
    }

    for (const timer of state.timers) {
      const card = cards.get(timer.id);
      if (card) {
        updateCard(card, timer);
      }
    }

    updateHeader();
    syncFinishWatchers();
    applyPendingFocus();
  }

  // ----------------------------------------------------------- board (DOM)

  function rebuildCards() {
    const present = new Set(state.timers.map((timer) => timer.id));

    for (const [timerId, card] of cards) {
      if (present.has(timerId)) continue;

      card.root.remove();
      cards.delete(timerId);
      expandedTimers.delete(timerId);
      finishWatchers.delete(timerId);
    }

    // `appendChild` move um no que ja esta no DOM, entao percorrer a lista na
    // ordem do servidor tambem resolve reordenacao sem recriar nada.
    for (const timer of state.timers) {
      let card = cards.get(timer.id);
      if (!card) {
        card = createCard(timer.id);
        cards.set(timer.id, card);
      }

      elements.board.appendChild(card.root);
    }
  }

  function createCard(timerId) {
    const root = elements.cardTemplate.content.firstElementChild.cloneNode(true);
    root.dataset.timerId = timerId;

    return {
      root,
      name: root.querySelector(".card-name"),
      directionBadge: root.querySelector(".card-badge-direction"),
      time: root.querySelector(".card-time"),
      meta: root.querySelector(".card-meta"),
      progressFill: root.querySelector(".card-progress-fill"),
      statusDot: root.querySelector(".status-dot"),
      statusText: root.querySelector(".card-status-text"),
      start: root.querySelector('[data-action="start"]'),
      pause: root.querySelector('[data-action="pause"]'),
      reset: root.querySelector('[data-action="reset"]'),
      primary: root.querySelector('[data-action="primary"]'),
      moveUp: root.querySelector('[data-action="move-up"]'),
      moveDown: root.querySelector('[data-action="move-down"]'),
      configToggle: root.querySelector('[data-action="toggle-config"]'),
      config: root.querySelector(".card-config"),
      applyTime: root.querySelector('[data-action="apply-time"]'),
      directionButtons: root.querySelectorAll('[data-action="direction"]'),
      inputHours: root.querySelector(".input-h"),
      inputMinutes: root.querySelector(".input-m"),
      inputSeconds: root.querySelector(".input-s"),
      note: root.querySelector(".card-config-note"),
    };
  }

  function updateCard(card, timer) {
    const isPrimary = timer.id === state.primaryTimerId;
    const isRunning = timer.status === "running";
    const isLast = timer.index === state.timers.length - 1;
    const phase = getPhase(timer.pct);
    const showsPhase = timer.status !== "stopped";

    card.root.classList.toggle("is-primary", isPrimary);
    card.root.dataset.status = timer.status;
    card.root.dataset.direction = timer.direction;

    // Sobrescrever o campo enquanto ele tem foco apagaria o que esta sendo
    // digitado a cada tick.
    if (document.activeElement !== card.name) {
      card.name.value = timer.name;
    }
    card.name.placeholder = getTimerLabel(timer);

    card.directionBadge.textContent =
      timer.direction === "up" ? "Progressivo" : "Regressivo";
    card.time.textContent = formatTime(getDisplayMs(timer));
    card.time.className = `card-time ${showsPhase ? phase : "green"}`;
    card.meta.textContent = getTimerMetaLabel(timer);

    // A barra drena no regressivo e enche no progressivo, seguindo o numero
    // que a pessoa esta lendo logo acima dela.
    const fillPct = timer.direction === "up" ? 1 - timer.pct : timer.pct;
    card.progressFill.style.width = `${Math.round(fillPct * 1000) / 10}%`;
    card.progressFill.dataset.phase = phase;

    card.statusDot.className = `status-dot ${timer.status}`;
    card.statusText.textContent = getStatusLabel(timer.status);

    card.start.disabled = isRunning || timer.status === "finished";
    card.pause.disabled = !isRunning;
    card.reset.disabled = timer.status === "stopped" && timer.elapsed === 0;
    card.primary.setAttribute("aria-pressed", String(isPrimary));
    card.primary.title = isPrimary
      ? "Já é o destaque do viewer"
      : "Destacar no viewer";
    card.moveUp.disabled = timer.index === 0;
    card.moveDown.disabled = isLast;

    for (const button of card.directionButtons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.direction === timer.direction),
      );
    }

    const expanded = expandedTimers.has(timer.id);
    card.config.hidden = !expanded;
    card.configToggle.setAttribute("aria-expanded", String(expanded));
    card.configToggle.textContent = expanded ? "Fechar ajustes" : "Ajustar";
    card.applyTime.disabled = isRunning;

    if (isRunning && !card.note.dataset.state) {
      card.note.textContent = "Pause o cronômetro para trocar o tempo.";
    } else if (!card.note.dataset.state) {
      card.note.textContent = "";
    }
  }

  function updateHeader() {
    const total = state.timers.length;
    const hasTimers = total > 0;

    if (elements.timerCount) {
      elements.timerCount.textContent = `${total}/${MAX_TIMERS_PER_SESSION}`;
    }
    if (elements.boardEmpty) {
      elements.boardEmpty.hidden = hasTimers;
    }
    if (elements.addTimer) {
      elements.addTimer.disabled = total >= MAX_TIMERS_PER_SESSION;
    }

    for (const button of [
      elements.startAll,
      elements.pauseAll,
      elements.resetAll,
    ]) {
      if (button) button.disabled = !hasTimers;
    }
  }

  function applyPendingFocus() {
    if (!pendingFocusTimerId) return;

    const card = cards.get(pendingFocusTimerId);
    pendingFocusTimerId = null;
    if (!card) return;

    card.name.focus();
    card.name.select();
  }

  function getStatusLabel(status) {
    switch (status) {
      case "running":
        return "RODANDO";
      case "paused":
        return "PAUSADO";
      case "finished":
        return "FINALIZADO";
      default:
        return "PARADO";
    }
  }

  // ------------------------------------------------------------- interacoes

  function onBoardClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled || !elements.board.contains(button)) return;

    const timerId = button.closest("[data-timer-id]")?.dataset.timerId;
    const timer = findTimer(timerId);
    if (!timer) return;

    switch (button.dataset.action) {
      case "start":
        socket.emit("timer:start", timerId);
        break;
      case "pause":
        socket.emit("timer:pause", timerId);
        break;
      case "reset":
        requestReset(timer);
        break;
      case "remove":
        requestRemove(timer);
        break;
      case "primary":
        socket.emit("timer:setPrimary", timerId);
        break;
      case "move-up":
        socket.emit("timer:move", timerId, -1);
        break;
      case "move-down":
        socket.emit("timer:move", timerId, 1);
        break;
      case "toggle-config":
        toggleConfig(timer);
        break;
      case "direction":
        socket.emit("timer:update", timerId, {
          direction: button.dataset.direction,
        });
        break;
      case "apply-time":
        applyCardTime(timer);
        break;
      case "save-model":
        saveModelFromCard(timer);
        break;
      default:
        break;
    }
  }

  function onBoardChange(event) {
    const input = event.target.closest(".card-name");
    if (!input) return;

    const timerId = input.closest("[data-timer-id]")?.dataset.timerId;
    if (!findTimer(timerId)) return;

    const name = sanitizeTimerName(input.value);
    input.value = name;
    socket.emit("timer:update", timerId, { name });
  }

  function onBoardKeydown(event) {
    if (event.key !== "Enter") return;

    if (event.target.closest(".card-name")) {
      event.preventDefault();
      event.target.blur();
      return;
    }

    if (event.target.closest(".card-config .time-field input")) {
      event.preventDefault();
      const timerId = event.target.closest("[data-timer-id]")?.dataset.timerId;
      const timer = findTimer(timerId);
      if (timer) applyCardTime(timer);
    }
  }

  function findTimer(timerId) {
    if (!timerId) return null;
    return state.timers.find((timer) => timer.id === timerId) || null;
  }

  function addTimer(model) {
    socket.emit(
      "timer:add",
      model
        ? {
            name: model.name,
            direction: model.direction,
            totalTime: model.secs * 1000,
          }
        : {},
      (response) => {
        if (!response?.success) {
          showBoardFeedback(
            response?.reason === "limit_reached"
              ? `Limite de ${MAX_TIMERS_PER_SESSION} cronômetros por sessão atingido.`
              : "Não foi possível adicionar o cronômetro.",
            "error",
          );
          return;
        }

        expandedTimers.add(response.timerId);
        pendingFocusTimerId = response.timerId;
      },
    );
  }

  function requestReset(timer) {
    if (
      timer.elapsed >= RESET_CONFIRM_MS &&
      !window.confirm(
        `Zerar "${getTimerLabel(timer)}"? A contagem atual será perdida.`,
      )
    ) {
      return;
    }

    socket.emit("timer:reset", timer.id);
  }

  function requestRemove(timer) {
    if (!window.confirm(`Remover "${getTimerLabel(timer)}" da sessão?`)) {
      return;
    }

    socket.emit("timer:remove", timer.id);
  }

  function bulkAction(action) {
    if (
      action === "reset" &&
      !window.confirm("Zerar todos os cronômetros da sessão?")
    ) {
      return;
    }

    socket.emit("timers:bulk", action);
  }

  function toggleConfig(timer) {
    const card = cards.get(timer.id);
    if (!card) return;

    if (expandedTimers.has(timer.id)) {
      expandedTimers.delete(timer.id);
    } else {
      expandedTimers.add(timer.id);
      // Os campos so sao preenchidos ao abrir: durante a contagem eles
      // sobrescreveriam o que a pessoa esta digitando.
      fillTimeInputs(card, timer.totalTime);
    }

    updateCard(card, timer);
  }

  function fillTimeInputs(card, totalTime) {
    const { hours, minutes, seconds } = splitDuration(totalTime);
    card.inputHours.value = String(hours);
    card.inputMinutes.value = String(minutes);
    card.inputSeconds.value = String(seconds);
  }

  function applyCardTime(timer) {
    const card = cards.get(timer.id);
    if (!card) return;

    const ms = readTimeInputs(card);
    if (ms === null) {
      showCardNote(
        card,
        `Informe um tempo entre 1 segundo e ${MAX_TIMER_HOURS} horas.`,
        "error",
      );
      return;
    }

    socket.emit("timer:update", timer.id, { totalTime: ms });
    showCardNote(card, "Tempo aplicado.", "success");
  }

  function readTimeInputs(card) {
    const hours = readNumberInput(card.inputHours, 0, MAX_TIMER_HOURS);
    const minutes = readNumberInput(card.inputMinutes, 0, 59);
    const seconds = readNumberInput(card.inputSeconds, 0, 59);
    const ms = (hours * 3600 + minutes * 60 + seconds) * 1000;

    if (ms < 1000 || ms > MAX_TIMER_MS) return null;
    return ms;
  }

  function readNumberInput(input, min, max) {
    const parsed = Number.parseInt(input?.value ?? "", 10);
    const safeValue = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, parsed))
      : min;

    if (input) input.value = String(safeValue);
    return safeValue;
  }

  function showCardNote(card, message, noteState) {
    card.note.textContent = message;
    card.note.dataset.state = noteState;

    window.setTimeout(() => {
      if (card.note.textContent !== message) return;
      card.note.textContent = "";
      delete card.note.dataset.state;
    }, FEEDBACK_TIMEOUT_MS);
  }

  function showBoardFeedback(message, feedbackState) {
    if (!elements.boardFeedback) return;

    window.clearTimeout(boardFeedbackTimer);
    elements.boardFeedback.textContent = message;
    elements.boardFeedback.dataset.state = feedbackState;

    if (!message) return;

    boardFeedbackTimer = window.setTimeout(() => {
      elements.boardFeedback.textContent = "";
      delete elements.boardFeedback.dataset.state;
    }, FEEDBACK_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------- modelos

  /**
   * Modelos ficam fora da sessao (localStorage global) porque servem para
   * remontar rapidamente o mesmo conjunto de cronometros em uma sessao nova.
   */
  function loadModels() {
    try {
      const raw =
        localStorage.getItem(MODELS_KEY) ??
        localStorage.getItem(legacyPresetsKey);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .map((model) => sanitizeModel(model))
        .filter(Boolean)
        .slice(0, MAX_MODELS);
    } catch {
      return [];
    }
  }

  function saveModels(models) {
    try {
      localStorage.setItem(MODELS_KEY, JSON.stringify(models));
    } catch {
      showModelFeedback("Não foi possível salvar o modelo.", "error");
    }
  }

  function sanitizeModel(raw) {
    if (!raw || typeof raw !== "object") return null;

    const name = sanitizeTimerName(raw.name);
    const parsed = Number(raw.secs);
    if (!name || !Number.isFinite(parsed)) return null;

    const secs = Math.trunc(parsed);
    if (secs < 1 || secs > MAX_TIMER_MS / 1000) return null;

    return { name, secs, direction: raw.direction === "up" ? "up" : "down" };
  }

  function upsertModel(model) {
    const models = loadModels().filter(
      (item) => item.name.toLowerCase() !== model.name.toLowerCase(),
    );

    models.push(model);
    saveModels(models.slice(-MAX_MODELS));
    renderModels();
  }

  function deleteModel(index) {
    const models = loadModels();
    models.splice(index, 1);
    saveModels(models);
    renderModels();
  }

  function renderModels() {
    const models = loadModels();
    renderModelChips(models);
    renderModelManage(models);
  }

  function renderModelChips(models) {
    const container = elements.modelsChips;
    if (!container) return;

    container.replaceChildren();

    if (!models.length) {
      container.appendChild(
        createTextNode(
          "models-empty",
          "Salve um modelo nas configurações para adicionar em um clique.",
        ),
      );
      return;
    }

    for (const model of models) {
      const button = document.createElement("button");
      button.className = "model-chip";
      button.type = "button";
      button.title = `Adicionar cronômetro "${model.name}"`;

      const name = document.createElement("span");
      name.className = "model-chip-name";
      name.textContent = model.name;

      const time = document.createElement("span");
      time.className = "model-chip-time";
      time.textContent = `${formatCompactDuration(model.secs * 1000)} ${
        model.direction === "up" ? "↑" : "↓"
      }`;

      button.append(name, time);
      button.addEventListener("click", () => addTimer(model));
      container.appendChild(button);
    }
  }

  function renderModelManage(models) {
    const container = elements.modelsManage;
    if (!container) return;

    container.replaceChildren();

    if (!models.length) {
      container.appendChild(
        createTextNode("models-empty", "Nenhum modelo salvo ainda."),
      );
      return;
    }

    models.forEach((model, index) => {
      const row = document.createElement("div");
      row.className = "model-row";

      const info = document.createElement("div");
      info.className = "model-row-info";

      const name = document.createElement("div");
      name.className = "model-row-name";
      name.textContent = model.name;

      const time = document.createElement("div");
      time.className = "model-row-time";
      time.textContent = `${formatCompactDuration(model.secs * 1000)} · ${
        model.direction === "up" ? "progressivo" : "regressivo"
      }`;

      const remove = document.createElement("button");
      remove.className = "model-row-del";
      remove.type = "button";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", `Excluir modelo ${model.name}`);
      remove.addEventListener("click", () => deleteModel(index));

      info.append(name, time);
      row.append(info, remove);
      container.appendChild(row);
    });
  }

  function addModelFromForm() {
    const name = sanitizeTimerName(elements.modelName?.value || "");
    const hours = readNumberInput(elements.modelHours, 0, MAX_TIMER_HOURS);
    const minutes = readNumberInput(elements.modelMinutes, 0, 59);
    const seconds = readNumberInput(elements.modelSeconds, 0, 59);
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;

    if (!name) {
      showModelFeedback("Digite um nome para o modelo.", "error");
      elements.modelName?.focus();
      return;
    }

    if (totalSeconds < 1) {
      showModelFeedback("Defina um tempo maior que zero.", "error");
      return;
    }

    upsertModel({
      name,
      secs: totalSeconds,
      direction: elements.modelDirection?.value === "up" ? "up" : "down",
    });

    if (elements.modelName) elements.modelName.value = "";
    showModelFeedback("Modelo salvo.", "success");
  }

  function saveModelFromCard(timer) {
    const card = cards.get(timer.id);
    if (!card) return;

    const ms = readTimeInputs(card);
    if (ms === null) {
      showCardNote(card, "Defina um tempo válido antes de salvar.", "error");
      return;
    }

    const name = sanitizeTimerName(card.name.value) || getTimerLabel(timer);
    upsertModel({ name, secs: ms / 1000, direction: timer.direction });
    showCardNote(card, `Modelo "${name}" salvo.`, "success");
  }

  function showModelFeedback(message, feedbackState) {
    const feedback = elements.modelFeedback;
    if (!feedback) return;

    window.clearTimeout(modelFeedbackTimer);
    feedback.textContent = message;

    if (message) {
      feedback.dataset.state = feedbackState;
    } else {
      delete feedback.dataset.state;
    }

    if (feedbackState !== "success" || !message) return;

    modelFeedbackTimer = window.setTimeout(() => {
      feedback.textContent = "";
      delete feedback.dataset.state;
    }, FEEDBACK_TIMEOUT_MS);
  }

  // ------------------------------------------------------------------ apoio

  function syncFinishWatchers() {
    for (const timer of state.timers) {
      let watcher = finishWatchers.get(timer.id);
      if (!watcher) {
        watcher = window.CronoFinishSound?.createWatcher();
        if (!watcher) return;
        finishWatchers.set(timer.id, watcher);
      }

      watcher.sync(timer.status, timer.remaining);
    }
  }

  function openSettings() {
    elements.settingsOverlay?.classList.add("open");
    renderModels();
    elements.modelName?.focus();
  }

  function closeSettings() {
    elements.settingsOverlay?.classList.remove("open");
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      return;
    }

    document.exitFullscreen().catch(() => {});
  }

  function syncFullscreenButton() {
    if (!elements.fullscreen) return;

    const isFullscreen = Boolean(document.fullscreenElement);
    elements.fullscreen.textContent = isFullscreen ? "✕" : "⛶";
    elements.fullscreen.title = isFullscreen ? "Sair da tela cheia" : "Tela cheia";
  }

  function createTextNode(className, text) {
    const element = document.createElement("div");
    element.className = className;
    element.textContent = text;
    return element;
  }

  function showError(message) {
    socket.disconnect();
    document.body.classList.add("message-mode");
    document.body.replaceChildren(createTextNode("screen-message", message));
  }
})();
