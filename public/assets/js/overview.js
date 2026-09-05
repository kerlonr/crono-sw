(() => {
  const {
    formatTime,
    getDisplayMs,
    getTimerLabel,
    isValidSessionId,
    sanitizeSessionState,
  } = window.CronoUtils;
  const overviewGrid = document.getElementById("overview-grid");
  const overviewEmpty = document.getElementById("overview-empty");
  const statOnline = document.getElementById("stat-online");
  const statRunning = document.getElementById("stat-running");
  const POLL_INTERVAL_MS = 3000;
  const closingSessions = new Set();
  let currentSessions = [];
  let pollTimer = 0;
  let requestInFlight = false;

  if (!overviewGrid || !overviewEmpty || !statOnline || !statRunning) {
    return;
  }

  startPolling();
  window.addEventListener("beforeunload", () => {
    stopPolling();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
      return;
    }

    startPolling(true);
  });

  async function loadSessions() {
    if (requestInFlight) {
      return;
    }

    requestInFlight = true;

    try {
      const response = await fetch("/api/sessions/active", {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Falha ao carregar os cronômetros.");
      }

      const data = await response.json();
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      currentSessions = sessions;
      renderOverview(sessions);
    } catch (error) {
      console.error(error);
      renderOverview([]);
    } finally {
      requestInFlight = false;
    }
  }

  function startPolling(runImmediately = true) {
    stopPolling();

    if (runImmediately) {
      loadSessions();
    }

    pollTimer = window.setInterval(loadSessions, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (!pollTimer) {
      return;
    }

    window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  const cards = new Map();
  let gridSignature = null;

  /**
   * Antes cada ciclo de 3s apagava a grade inteira e remontava tudo. Isso
   * reiniciava a animacao da borda dos cards, cortava qualquer transicao de
   * cor pela metade e piscava o texto. Agora o DOM so e recriado quando a
   * lista de sessoes muda; nos demais ciclos os campos sao atualizados no
   * lugar, e as transicoes do CSS acontecem de verdade.
   */
  function renderOverview(sessions) {
    statOnline.textContent = String(sessions.length);
    statRunning.textContent = String(
      sessions.filter((session) => session?.status === "running").length,
    );

    if (!sessions.length) {
      overviewEmpty.classList.add("visible");
      overviewGrid.replaceChildren();
      cards.clear();
      gridSignature = null;
      return;
    }

    overviewEmpty.classList.remove("visible");

    const signature = sessions.map((session) => session.id).join(",");
    if (signature !== gridSignature) {
      const presentes = new Set(sessions.map((session) => session.id));
      for (const [id, card] of cards) {
        if (presentes.has(id)) continue;
        card.root.remove();
        cards.delete(id);
      }

      for (const session of sessions) {
        let card = cards.get(session.id);
        if (!card) {
          card = createTimerCard(session);
          cards.set(session.id, card);
        }
        overviewGrid.appendChild(card.root);
      }

      gridSignature = signature;
    }

    for (const session of sessions) {
      updateTimerCard(cards.get(session.id), session);
    }
  }

  function createTimerCard(session) {
    const root = document.createElement("article");
    root.className = "timer-card";

    const top = document.createElement("div");
    top.className = "card-top";

    const identity = document.createElement("div");

    const id = document.createElement("div");
    id.className = "card-id";
    id.textContent = `Sessão ${session.id}`;

    const created = document.createElement("div");
    created.className = "card-created";
    created.textContent = `Criado em ${formatDate(session.createdAt)}`;

    identity.append(id, created);

    const status = document.createElement("div");
    status.className = "card-status";

    const primaryLabel = document.createElement("div");
    primaryLabel.className = "card-primary-label";

    const timer = document.createElement("div");
    timer.className = "card-timer";

    const list = document.createElement("div");
    list.className = "card-timer-list";

    const meta = document.createElement("div");
    meta.className = "card-meta";

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const actionButtons = document.createElement("div");
    actionButtons.className = "card-action-buttons";

    const link = document.createElement("a");
    link.className = "card-link";
    link.href = `/view/${session.id}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Viewer";

    // Caminho de volta para quem perdeu o link do admin: a tela de admin
    // pede usuario e senha quando o token nao esta no endereco.
    const adminLink = document.createElement("a");
    adminLink.className = "card-link";
    adminLink.href = `/admin/${session.id}`;
    adminLink.target = "_blank";
    adminLink.rel = "noopener noreferrer";

    const closeButton = document.createElement("button");
    closeButton.className = "card-link card-end-button";
    closeButton.type = "button";
    closeButton.addEventListener("click", () => closeSession(session.id));

    const note = document.createElement("div");
    note.className = "card-note";

    actionButtons.append(link, adminLink, closeButton);
    actions.append(actionButtons, note);
    top.append(identity, status);
    root.append(top, primaryLabel, timer, list, meta, actions);

    return {
      root,
      status,
      primaryLabel,
      timer,
      list,
      listSignature: null,
      meta,
      adminLink,
      closeButton,
      note,
    };
  }

  function updateTimerCard(card, session) {
    if (!card) return;

    const { timers, primaryTimerId } = sanitizeSessionState(session);
    const primary = timers.find((timer) => timer.id === primaryTimerId) ?? null;
    const state = mapStatus(session.status, primary);

    card.root.className = `timer-card${state.cardClass ? ` ${state.cardClass}` : ""}`;
    card.status.dataset.state = state.className;
    card.status.textContent = state.label;

    card.primaryLabel.textContent = primary
      ? getTimerLabel(primary)
      : "Sem cronômetros";
    card.timer.textContent = primary
      ? formatTime(getDisplayMs(primary))
      : "--:--:--";
    card.meta.textContent = state.copy;

    const outros = timers.filter((timer) => timer !== primary);
    renderTimerList(card, outros);

    card.adminLink.textContent = session.hasAuth ? "Admin 🔒" : "Admin";
    card.adminLink.title = session.hasAuth
      ? "Entrar com usuário e senha"
      : "Esta sessão não tem usuário e senha definidos";

    const encerrando = closingSessions.has(session.id);
    card.closeButton.disabled = encerrando;
    card.closeButton.textContent = encerrando ? "Encerrando" : "Finalizar";

    card.note.textContent = `Atualizado ${formatRelative(session.lastAccessAt)}`;
  }

  /** Linhas compactas dos cronometros que nao estao em destaque. */
  function renderTimerList(card, timers) {
    const signature = timers.map((timer) => timer.id).join(",");

    if (signature !== card.listSignature) {
      card.list.replaceChildren();

      for (const timer of timers) {
        const row = document.createElement("div");
        row.className = "card-timer-row";
        row.dataset.timerId = timer.id;

        const label = document.createElement("span");
        label.className = "card-timer-row-label";

        const value = document.createElement("span");
        value.className = "card-timer-row-value";

        row.append(label, value);
        card.list.appendChild(row);
      }

      card.listSignature = signature;
    }

    card.list.hidden = timers.length === 0;

    timers.forEach((timer, index) => {
      const row = card.list.children[index];
      if (!row) return;
      row.dataset.status = timer.status;
      row.firstChild.textContent = getTimerLabel(timer);
      row.lastChild.textContent = formatTime(getDisplayMs(timer));
    });
  }

  async function closeSession(sessionId) {
    if (!isValidSessionId(sessionId) || closingSessions.has(sessionId)) {
      return;
    }

    const confirmed = window.confirm("Finalizar esta sessão?");
    if (!confirmed) {
      return;
    }

    closingSessions.add(sessionId);
    renderOverview(currentSessions);

    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error("Falha ao finalizar a sessão.");
      }

      currentSessions = currentSessions.filter((session) => session?.id !== sessionId);
      renderOverview(currentSessions);
      loadSessions();
    } catch (error) {
      console.error(error);
    } finally {
      closingSessions.delete(sessionId);
      renderOverview(currentSessions);
    }
  }

  /**
   * Resume a sessao a partir do status agregado e do cronometro em destaque,
   * que e o que a pessoa ve grande no card.
   */
  function mapStatus(status, primary) {
    const pct = primary ? primary.pct : 1;

    if (!primary || status === "finished") {
      return {
        label: "Finalizado",
        className: "finished",
        cardClass: "is-finished",
        copy: primary
          ? "Todos os cronômetros chegaram ao fim."
          : "Sessão sem cronômetros configurados.",
      };
    }

    if (status === "running") {
      if (pct <= 0.2) {
        return {
          label: pct <= 0.1 ? "Urgente" : "Atenção",
          className: "running",
          cardClass: "is-danger",
          copy: "Fase final do cronômetro em destaque.",
        };
      }

      if (pct <= 0.4) {
        return {
          label: "Em andamento",
          className: "running",
          cardClass: "is-warning",
          copy: "Contagem rodando com menos da metade restante.",
        };
      }

      return {
        label: "Rodando",
        className: "running",
        cardClass: "is-running",
        copy: "Sessão com cronômetro ativo em tempo real.",
      };
    }

    if (status === "paused") {
      return {
        label: "Pausado",
        className: "paused",
        cardClass: pct <= 0.2 ? "is-warning" : "",
        copy: "A sessão está pausada no momento.",
      };
    }

    return {
      label: "Parado",
      className: "stopped",
      cardClass: "",
      copy: "Pronto para ser iniciado pelo admin.",
    };
  }

  function formatDate(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) {
      return "agora";
    }

    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(date);
  }

  function formatRelative(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) {
      return "há pouco";
    }

    const diffSeconds = Math.max(0, Math.round((Date.now() - value) / 1000));

    if (diffSeconds < 5) return "agora";
    if (diffSeconds < 60) return `há ${diffSeconds}s`;

    const diffMinutes = Math.round(diffSeconds / 60);
    if (diffMinutes < 60) return `há ${diffMinutes}min`;

    const diffHours = Math.round(diffMinutes / 60);
    return `há ${diffHours}h`;
  }

})();
