/**
 * Viewer publico: um cronometro em destaque ocupando a tela e os demais em
 * cards menores no rodape.
 *
 * Como no admin, os cards secundarios so sao recriados quando a lista muda; os
 * ticks apenas atualizam texto, cor e largura da barra.
 */
(() => {
  const {
    formatTime,
    getDisplayMs,
    getPhase,
    getTimerLabel,
    getTimerMetaLabel,
    isValidSessionId,
    sanitizeSessionState,
  } = window.CronoUtils;

  const GLOWS = {
    green:
      "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(0,245,160,0.05) 0%, transparent 70%)",
    yellow:
      "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(255,184,0,0.07) 0%, transparent 70%)",
    red: "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(255,62,62,0.08) 0%, transparent 70%)",
    blink:
      "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(255,62,62,0.12) 0%, transparent 70%)",
    finished:
      "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(255,62,62,0.25) 0%, transparent 70%)",
  };

  const socket = io();
  const sessionId = window.location.pathname.split("/").pop();

  const elements = {
    board: document.getElementById("viewer-board"),
    glowBg: document.getElementById("glow-bg"),
    message: document.getElementById("viewer-message"),
    primary: document.getElementById("viewer-primary"),
    primaryLabel: document.getElementById("viewer-primary-label"),
    primaryMeta: document.getElementById("viewer-primary-meta"),
    primaryProgress: document.getElementById("viewer-primary-progress"),
    primaryTime: document.getElementById("viewer-primary-time"),
    secondaries: document.getElementById("viewer-secondaries"),
    state: document.getElementById("viewer-state"),
    cardTemplate: document.getElementById("viewer-card-template"),
  };

  const cards = new Map();
  const finishWatchers = new Map();
  const linkStatus = document.getElementById("link-status");

  let secondarySignature = null;

  if (!elements.board || !elements.primary || !elements.cardTemplate) {
    return;
  }

  if (!isValidSessionId(sessionId)) {
    showError("Sessão não encontrada.");
    return;
  }

  let tentativasDeEntrada = 0;

  // O viewer costuma ficar horas projetado, sem ninguem tocando. Quando o
  // socket cai por ociosidade, o Socket.IO reconecta com um socket novo, que
  // nao esta em sala nenhuma - sem reentrar aqui, a tela congela no ultimo
  // valor recebido, parecendo travada.
  socket.on("connect", entrarNaSessao);
  socket.on("disconnect", () => setConexao("Reconectando..."));
  socket.on("connect_error", () => setConexao("Sem conexão. Tentando..."));

  if (socket.connected) entrarNaSessao();

  function entrarNaSessao() {
    socket.emit("session:join", sessionId, "viewer", (response) => {
      if (response?.success) {
        tentativasDeEntrada = 0;
        return setConexao("");
      }

      if (tentativasDeEntrada < 6) {
        tentativasDeEntrada += 1;
        setConexao(`Reconectando... (${tentativasDeEntrada}/6)`);
        return window.setTimeout(entrarNaSessao, 2000);
      }

      showError("Sessão não encontrada.");
    });
  }

  function setConexao(mensagem) {
    if (!linkStatus) return;
    linkStatus.textContent = mensagem;
    linkStatus.hidden = !mensagem;
  }

  socket.on("session:closed", () => {
    showError("Sessão encerrada.");
  });

  socket.on("session:state", (raw) => {
    const state = sanitizeSessionState(raw);
    const primary =
      state.timers.find((timer) => timer.id === state.primaryTimerId) ?? null;
    const secondaries = state.timers.filter((timer) => timer !== primary);

    syncFinishWatchers(state.timers);
    renderPrimary(primary);
    renderSecondaries(secondaries);
  });

  function renderPrimary(timer) {
    const hasPrimary = Boolean(timer);

    elements.primary.hidden = !hasPrimary;
    if (elements.message) {
      elements.message.hidden = hasPrimary;
    }

    if (!hasPrimary) {
      document.body.classList.remove("flash-red", "finished");
      elements.glowBg.style.background = "none";
      return;
    }

    const phase = getPhase(timer.pct);
    const isFinished = timer.status === "finished" || timer.remaining <= 0;

    elements.primaryLabel.textContent = getTimerLabel(timer);
    setEstado(timer);
    elements.primaryMeta.textContent = getTimerMetaLabel(timer);
    elements.primaryTime.textContent = formatTime(getDisplayMs(timer));
    elements.primaryTime.className = `timer-display ${buildTimerClass(
      timer,
      phase,
    )}`;
    setProgress(elements.primaryProgress, timer, phase);

    document.body.classList.toggle("flash-red", isFinished);
    document.body.classList.toggle("finished", isFinished);

    if (isFinished) {
      elements.glowBg.style.background = GLOWS.finished;
      return;
    }

    elements.glowBg.style.background =
      timer.status === "running" ? (GLOWS[phase] ?? GLOWS.green) : "none";
  }

  /**
   * Estado escrito por extenso. Antes o unico sinal de pausado era a opacidade
   * mais baixa - quem abrisse a tela ja pausada nao tinha como saber, porque
   * nao viu a mudanca acontecer.
   */
  function setEstado(timer) {
    if (!elements.state) return;

    const rotulo = {
      paused: "Pausado",
      stopped: "Parado",
      finished: "Encerrado",
    }[timer.status];

    elements.state.textContent = rotulo || "";
    elements.state.dataset.status = timer.status;
    elements.state.hidden = !rotulo;
  }

  function renderSecondaries(timers) {
    const signature = timers.map((timer) => timer.id).join(",");

    if (signature !== secondarySignature) {
      rebuildSecondaries(timers);
      secondarySignature = signature;
    }

    elements.secondaries.hidden = timers.length === 0;
    elements.secondaries.dataset.count = String(timers.length);

    for (const timer of timers) {
      const card = cards.get(timer.id);
      if (card) {
        updateSecondary(card, timer);
      }
    }
  }

  function rebuildSecondaries(timers) {
    const present = new Set(timers.map((timer) => timer.id));

    for (const [timerId, card] of cards) {
      if (present.has(timerId)) continue;
      card.root.remove();
      cards.delete(timerId);
    }

    for (const timer of timers) {
      let card = cards.get(timer.id);
      if (!card) {
        card = createSecondary();
        cards.set(timer.id, card);
      }

      elements.secondaries.appendChild(card.root);
    }
  }

  function createSecondary() {
    const root = elements.cardTemplate.content.firstElementChild.cloneNode(true);

    return {
      root,
      label: root.querySelector(".viewer-card-label"),
      time: root.querySelector(".viewer-card-time"),
      progress: root.querySelector(".viewer-progress-fill"),
    };
  }

  function updateSecondary(card, timer) {
    const phase = getPhase(timer.pct);

    card.root.dataset.status = timer.status;
    card.label.textContent = getTimerLabel(timer);
    card.time.textContent = formatTime(getDisplayMs(timer));
    card.time.className = `viewer-card-time ${buildTimerClass(timer, phase)}`;
    setProgress(card.progress, timer, phase);
  }

  /** Cor pela fase quando ativo; parado fica neutro, pausado fica esmaecido. */
  function buildTimerClass(timer, phase) {
    if (timer.status === "finished" || timer.remaining <= 0) return "red";
    if (timer.status === "running") return phase;
    if (timer.status === "paused") return `${phase} paused`;
    return "green";
  }

  function setProgress(element, timer, phase) {
    if (!element) return;

    const fillPct = timer.direction === "up" ? 1 - timer.pct : timer.pct;
    element.style.width = `${Math.round(fillPct * 1000) / 10}%`;
    element.dataset.phase = phase;
  }

  function syncFinishWatchers(timers) {
    const present = new Set(timers.map((timer) => timer.id));

    for (const timerId of finishWatchers.keys()) {
      if (!present.has(timerId)) {
        finishWatchers.delete(timerId);
      }
    }

    for (const timer of timers) {
      let watcher = finishWatchers.get(timer.id);
      if (!watcher) {
        watcher = window.CronoFinishSound?.createWatcher();
        if (!watcher) return;
        finishWatchers.set(timer.id, watcher);
      }

      watcher.sync(timer.status, timer.remaining);
    }
  }

  function showError(message) {
    socket.disconnect();
    document.body.classList.add("message-mode");
    document.body.replaceChildren(createMessage(message));
  }

  function createMessage(message) {
    const element = document.createElement("div");
    element.className = "screen-message";
    element.textContent = message;
    return element;
  }
})();
