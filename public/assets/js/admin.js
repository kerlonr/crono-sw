/**
 * Painel de administracao.
 *
 * A tela mantem o desenho original: o cronometro em destaque ocupa o bloco
 * grande de sempre e os demais aparecem em blocos compactos logo abaixo. Toda
 * a configuracao vive no modal, para a tela principal seguir limpa.
 *
 * O DOM dos secundarios so e reconstruido quando a lista muda; nos ticks de
 * 250ms apenas textos, classes e larguras sao atualizados. O formulario do
 * modal, por sua vez, so e preenchido ao trocar de selecao ou ao abrir - se
 * fosse a cada tick, apagaria o que estivesse sendo digitado.
 */
(() => {
  const {
    MAX_TIMERS_PER_SESSION,
    MAX_TIMER_MS,
    formatCompactDuration,
    formatTime,
    getAccrualLabel,
    getBonusLabel,
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
  const MIN_ACCRUAL_EVERY_MS = 60 * 1000;
  const RESET_CONFIRM_MS = 60 * 1000;
  const FEEDBACK_MS = 2600;

  const socket = io();
  const sessionId = window.location.pathname.split("/").pop();
  let adminToken = window.location.hash.slice(1);
  const legacyPresetsKey = `crono_sw_presets_${sessionId}`;

  const el = (id) => document.getElementById(id);

  const ui = {
    panel: el("admin-panel"),
    // destaque
    primaryBlock: el("primary-block"),
    primaryName: el("primary-name"),
    primaryTime: el("primary-time"),
    primaryMeta: el("primary-meta"),
    primaryProgress: el("primary-progress"),
    primaryDot: el("primary-dot"),
    primaryStatus: el("primary-status"),
    primaryStart: el("primary-start"),
    primaryPause: el("primary-pause"),
    primaryReset: el("primary-reset"),
    // secundarios
    strip: el("timer-strip"),
    miniTemplate: el("timer-mini-template"),
    boardEmpty: el("board-empty"),
    boardFeedback: el("board-feedback"),
    // barra superior
    modelsChips: el("models-chips"),
    addTimer: el("btn-add-timer"),
    fullscreen: el("btn-fs"),
    openModal: el("btn-open-modal"),
    // modal
    overlay: el("modal-overlay"),
    closeModal: el("btn-close-modal"),
    config: el("timer-config"),
    configTitle: el("timer-config-title"),
    closeConfig: el("btn-close-config"),
    cfgName: el("cfg-name"),
    cfgDirectionHint: el("cfg-direction-hint"),
    cfgH: el("cfg-h"),
    cfgM: el("cfg-m"),
    cfgS: el("cfg-s"),
    cfgTimeLabel: el("cfg-time-label"),
    cfgTimeHint: el("cfg-time-hint"),
    applyStart: el("btn-apply-start"),
    offsetStart: el("btn-offset-start"),
    cfgOffsetLabel: el("cfg-offset-label"),
    clockRow: el("clock-row"),
    clockLabel: el("clock-label"),
    clockHint: el("clock-hint"),
    cfgClock: el("cfg-clock"),
    fromClock: el("btn-from-clock"),
    cfgOffH: el("cfg-off-h"),
    cfgOffM: el("cfg-off-m"),
    cfgOffS: el("cfg-off-s"),
    cfgOffsetHint: el("cfg-offset-hint"),
    applyOffset: el("btn-apply-offset"),
    clearOffset: el("btn-clear-offset"),
    applyTime: el("btn-apply-time"),
    saveModel: el("btn-save-model"),
    accrualEnabled: el("accrual-enabled"),
    accrualSentence: el("accrual-sentence"),
    accrualEveryH: el("accrual-every-h"),
    accrualEveryM: el("accrual-every-m"),
    accrualSource: el("accrual-source"),
    accrualAddM: el("accrual-add-m"),
    accrualStatus: el("accrual-status"),
    setPrimary: el("btn-set-primary"),
    moveUp: el("btn-move-up"),
    moveDown: el("btn-move-down"),
    removeTimer: el("btn-remove-timer"),
    modelsManage: el("models-manage"),
    linkStatus: el("link-status"),
    loginShell: el("login-shell"),
    loginForm: el("login-form"),
    loginUser: el("login-user"),
    loginPass: el("login-pass"),
    loginFeedback: el("login-feedback"),
    authUser: el("auth-user"),
    authPass: el("auth-pass"),
    saveAuth: el("btn-save-auth"),
    clearAuth: el("btn-clear-auth"),
    authFeedback: el("auth-feedback"),
    viewerLinks: document.querySelectorAll(".viewer-direct-link"),
  };

  const minis = new Map();
  const finishWatchers = new Map();

  let state = { timers: [], primaryTimerId: null };
  let stripSignature = null;
  // Um unico painel de ajustes, movido para dentro do bloco aberto. Manter um
  // formulario por cronometro duplicaria os campos e os listeners.
  let openTimerId = null;
  let selectedTimerId = null;
  let feedbackTimer = 0;
  let entrou = false;
  let tentativasDeEntrada = 0;

  if (!ui.panel || !ui.strip || !ui.miniTemplate || !isValidSessionId(sessionId)) {
    return showError("Sessão não encontrada.");
  }

  bindLogin();

  if (!isValidAdminToken(adminToken)) {
    return showLogin();
  }

  bindEvents();
  connect();

  // ----------------------------------------------------------------- login

  /**
   * O token continua sendo a credencial de fato; usuario e senha servem para
   * recupera-lo quando o link se perde.
   */
  function bindLogin() {
    ui.loginForm?.addEventListener("submit", async (event) => {
      event.preventDefault();

      const username = ui.loginUser.value.trim();
      const password = ui.loginPass.value;
      if (!username || !password) {
        return setLoginFeedback("Informe usuário e senha.");
      }

      ui.loginForm.querySelector("button").disabled = true;
      setLoginFeedback("Entrando...");

      try {
        const response = await fetch(`/api/session/${sessionId}/login`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ username, password }),
        });

        if (response.status === 429) {
          return setLoginFeedback(
            "Muitas tentativas. Espere alguns minutos e tente de novo.",
          );
        }
        if (!response.ok) {
          return setLoginFeedback("Usuário ou senha inválidos.");
        }

        const data = await response.json();
        if (!isValidAdminToken(data?.adminToken)) {
          return setLoginFeedback("Resposta inválida do servidor.");
        }

        // Guarda o token no hash para recarregar sem pedir login de novo.
        adminToken = data.adminToken;
        window.location.hash = adminToken;
        ui.loginShell.hidden = true;
        ui.loginPass.value = "";
        setLoginFeedback("");

        bindEvents();
        connect();
      } catch {
        setLoginFeedback("Não foi possível falar com o servidor.");
      } finally {
        const botao = ui.loginForm.querySelector("button");
        if (botao) botao.disabled = false;
      }
    });
  }

  function showLogin() {
    if (!ui.loginShell) {
      return showError("Acesso de admin inválido ou expirado.");
    }

    document.body.classList.add("login-mode");
    ui.loginShell.hidden = false;
    ui.loginUser?.focus();
  }

  function setLoginFeedback(message) {
    if (ui.loginFeedback) ui.loginFeedback.textContent = message;
  }

  // --------------------------------------------------------------- conexao

  /**
   * Ao reconectar, o Socket.IO cria um socket NOVO no servidor - sem sala e
   * sem papel de admin. Sem reentrar na sessao a tela congela e os controles
   * param de responder em silencio, que era o sintoma de "a sessao caiu"
   * depois de um tempo com a aba fora de foco. Entrar no evento `connect`
   * cobre a primeira conexao e todas as reconexoes.
   */
  function connect() {
    socket.on("connect", entrarNaSessao);
    socket.on("disconnect", () => setConexao("Reconectando..."));

    if (socket.connected) entrarNaSessao();
  }

  function entrarNaSessao() {
    socket.emit("session:join", sessionId, "admin", adminToken, (response) => {
      if (response?.success) {
        tentativasDeEntrada = 0;
        setConexao("");

        if (entrou) return;
        entrou = true;

        ui.panel.style.display = "block";
        for (const link of ui.viewerLinks) link.href = `/view/${sessionId}`;
        renderModels();
        syncFullscreen();
        return;
      }

      if (response?.reason === "unauthorized") {
        return showError("Acesso de admin inválido ou expirado.");
      }

      // "nao encontrada" logo apos um reinicio do servidor costuma ser corrida
      // com a restauracao do snapshot. Vale tentar de novo antes de derrubar a
      // tela do usuario, que so teria a opcao de recarregar na mao.
      if (tentativasDeEntrada < 6) {
        tentativasDeEntrada += 1;
        setConexao(`Reconectando... (${tentativasDeEntrada}/6)`);
        window.setTimeout(entrarNaSessao, 2000);
        return;
      }

      showError("Sessão não encontrada.");
    });
  }

  function setConexao(mensagem) {
    if (!ui.linkStatus) return;
    ui.linkStatus.textContent = mensagem;
    ui.linkStatus.hidden = !mensagem;
  }

  function bindEvents() {
    socket.on("session:state", applyState);
    // Falha de conexao nao e fatal: o Socket.IO segue tentando sozinho, e
    // derrubar a tela aqui apagaria um painel que volta a funcionar em
    // segundos.
    socket.on("connect_error", () => setConexao("Sem conexão. Tentando..."));
    socket.on("session:closed", () => showError("Sessão encerrada."));

    for (const root of [ui.primaryBlock, ui.strip]) {
      root.addEventListener("click", (event) => {
        const button = event.target.closest("[data-action]");
        if (!button || button.disabled || !root.contains(button)) return;
        runAction(
          button.dataset.action,
          button.closest("[data-timer-id]")?.dataset.timerId,
        );
      });
    }

    ui.closeConfig?.addEventListener("click", closeConfig);
    ui.addTimer?.addEventListener("click", () => addTimer());
    ui.fullscreen?.addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", syncFullscreen);

    ui.openModal?.addEventListener("click", openModal);
    ui.closeModal?.addEventListener("click", closeModal);
    ui.overlay?.addEventListener("click", (event) => {
      if (event.target === ui.overlay) closeModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closeModal();
      closeConfig();
    });

    // Titulo e modo valem na hora: sao so apresentacao, nao mexem na contagem.
    ui.cfgName?.addEventListener("change", () => {
      const name = sanitizeTimerName(ui.cfgName.value);
      ui.cfgName.value = name;
      emitUpdate({ name });
    });
    ui.config?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-direction]");
      if (!button) return;
      emitUpdate({ direction: button.dataset.direction });
    });

    ui.applyTime?.addEventListener("click", () => applyTime(false));
    ui.applyStart?.addEventListener("click", () => applyTime(true));
    ui.applyOffset?.addEventListener("click", () => applyOffset(readOffsetMs(), false));
    ui.offsetStart?.addEventListener("click", () => applyOffset(readOffsetMs(), true));
    ui.clearOffset?.addEventListener("click", () => applyOffset(0, false));
    ui.fromClock?.addEventListener("click", fillFromClock);

    // Ajuste rapido: mexer nos campos de hora um a um para somar 5 minutos e
    // o tipo de atrito que faz a tela parecer ruim de usar.
    ui.config?.addEventListener("click", (event) => {
      const passo = event.target.closest("[data-step], [data-off-step]");
      if (!passo) return;

      const paraDuracao = passo.hasAttribute("data-step");
      const delta = Number(
        paraDuracao ? passo.dataset.step : passo.dataset.offStep,
      );
      const atual = paraDuracao ? readTimeMs() : readOffsetMs();
      const alvo = Math.max(0, atual + delta);

      if (paraDuracao) fillTimeInputs(alvo);
      else fillOffsetInputs(alvo);
    });
    ui.saveModel?.addEventListener("click", saveModelFromSelected);
    ui.setPrimary?.addEventListener("click", () => {
      if (selectedTimerId) socket.emit("timer:setPrimary", selectedTimerId);
    });
    ui.moveUp?.addEventListener("click", () => moveSelected(-1));
    ui.moveDown?.addEventListener("click", () => moveSelected(1));
    ui.removeTimer?.addEventListener("click", removeSelected);

    ui.saveAuth?.addEventListener("click", () => {
      const username = ui.authUser.value.trim();
      const password = ui.authPass.value;

      if (!username || !password) {
        return setAuthFeedback("Informe usuário e senha.");
      }

      socket.emit("session:setAuth", { username, password }, (resposta) => {
        ui.authPass.value = "";
        setAuthFeedback(
          resposta?.success
            ? `Acesso salvo. Entre com "${username}" se perder o link.`
            : "Não foi possível salvar o acesso.",
        );
      });
    });

    ui.clearAuth?.addEventListener("click", () => {
      if (!window.confirm("Remover usuário e senha desta sessão?")) return;

      socket.emit("session:setAuth", {}, (resposta) => {
        ui.authUser.value = "";
        ui.authPass.value = "";
        setAuthFeedback(
          resposta?.success
            ? "Acesso removido. Só o link controla esta sessão agora."
            : "Não foi possível remover o acesso.",
        );
      });
    });

    ui.accrualEnabled?.addEventListener("change", applyAccrual);
    for (const field of [
      ui.accrualEveryH,
      ui.accrualEveryM,
      ui.accrualSource,
      ui.accrualAddM,
    ]) {
      field?.addEventListener("change", applyAccrual);
    }
  }

  function applyState(raw) {
    state = sanitizeSessionState(raw);

    if (!findTimer(selectedTimerId)) {
      selectedTimerId = state.primaryTimerId;
    }

    const primary = findTimer(state.primaryTimerId);
    renderPrimary(primary);
    renderStrip(state.timers.filter((timer) => timer !== primary));
    placeConfig(false);
    syncWatchers();

    ui.boardEmpty.hidden = state.timers.length > 0;
    ui.primaryBlock.hidden = !primary;
  }

  // -------------------------------------------------------------- destaque

  function renderPrimary(timer) {
    if (!timer) return;

    ui.primaryBlock.dataset.timerId = timer.id;

    const phase = getPhase(timer.pct);
    const active = timer.status !== "stopped";

    ui.primaryName.textContent = getTimerLabel(timer);
    ui.primaryTime.textContent = formatTime(getDisplayMs(timer));
    ui.primaryTime.className = `timer-display timer-display-d ${
      active ? phase : "green"
    }${timer.status === "paused" ? " paused" : ""}`;

    ui.primaryMeta.replaceChildren(
      document.createTextNode(getTimerMetaLabel(timer)),
    );
    const bonus = getBonusLabel(timer);
    if (bonus) {
      const tag = document.createElement("span");
      tag.className = "bonus-tag";
      tag.textContent = bonus;
      ui.primaryMeta.appendChild(tag);
    }

    setProgress(ui.primaryProgress, timer, phase);
    ui.primaryDot.className = `status-dot ${timer.status}`;
    ui.primaryStatus.textContent = statusLabel(timer.status);
    ui.primaryStart.disabled = timer.status === "running" || timer.status === "finished";
    ui.primaryPause.disabled = timer.status !== "running";
    ui.primaryReset.disabled = timer.status === "stopped" && timer.elapsed === 0;
  }

  // ----------------------------------------------------------- secundarios

  function renderStrip(timers) {
    const signature = timers.map((timer) => timer.id).join(",");

    if (signature !== stripSignature) {
      const present = new Set(timers.map((timer) => timer.id));
      for (const [id, mini] of minis) {
        if (present.has(id)) continue;
        mini.root.remove();
        minis.delete(id);
      }
      for (const timer of timers) {
        let mini = minis.get(timer.id);
        if (!mini) {
          mini = createMini(timer.id);
          minis.set(timer.id, mini);
        }
        ui.strip.appendChild(mini.root);
      }
      stripSignature = signature;
    }

    for (const timer of timers) updateMini(minis.get(timer.id), timer);
  }

  function createMini(timerId) {
    const root = ui.miniTemplate.content.firstElementChild.cloneNode(true);
    root.dataset.timerId = timerId;

    return {
      root,
      dot: root.querySelector(".timer-mini-dot"),
      name: root.querySelector(".timer-mini-name"),
      time: root.querySelector(".timer-mini-time"),
      meta: root.querySelector(".timer-mini-meta"),
      progress: root.querySelector(".progress-fill"),
      start: root.querySelector('[data-action="start"]'),
      pause: root.querySelector('[data-action="pause"]'),
      reset: root.querySelector('[data-action="reset"]'),
    };
  }

  function updateMini(mini, timer) {
    if (!mini) return;

    const phase = getPhase(timer.pct);
    const active = timer.status !== "stopped";
    const bonus = getBonusLabel(timer);

    mini.dot.className = `timer-mini-dot ${timer.status}`;
    mini.name.textContent = getTimerLabel(timer);
    mini.time.textContent = formatTime(getDisplayMs(timer));
    mini.time.className = `timer-mini-time ${active ? phase : "green"}${
      timer.status === "paused" ? " paused" : ""
    }`;
    mini.meta.textContent = bonus
      ? `${formatCompactDuration(timer.baseTotalTime)} · ${bonus}`
      : formatCompactDuration(timer.totalTime);
    setProgress(mini.progress, timer, phase);

    mini.start.disabled = timer.status === "running" || timer.status === "finished";
    mini.pause.disabled = timer.status !== "running";
    mini.reset.disabled = timer.status === "stopped" && timer.elapsed === 0;
  }

  function setProgress(element, timer, phase) {
    const fill = timer.direction === "up" ? 1 - timer.pct : timer.pct;
    element.style.width = `${Math.round(fill * 1000) / 10}%`;
    element.dataset.phase = phase;
  }

  // ------------------------------------------------------------------ acoes

  function runAction(action, timerId) {
    const timer = findTimer(timerId);
    if (!timer) return;

    if (action === "config") {
      return toggleConfig(timer.id);
    }

    if (action === "reset") {
      if (
        timer.elapsed >= RESET_CONFIRM_MS &&
        !window.confirm(
          `Zerar "${getTimerLabel(timer)}"? A contagem atual será perdida.`,
        )
      ) {
        return;
      }
      return socket.emit("timer:reset", timer.id);
    }

    socket.emit(`timer:${action}`, timer.id);
  }

  function addTimer(model) {
    socket.emit(
      "timer:add",
      model
        ? { name: model.name, direction: model.direction, totalTime: model.secs * 1000 }
        : {},
      (response) => {
        if (!response?.success) {
          return showFeedback(
            response?.reason === "limit_reached"
              ? `Limite de ${MAX_TIMERS_PER_SESSION} cronômetros por sessão.`
              : "Não foi possível adicionar o cronômetro.",
            "error",
          );
        }

        // Abre os ajustes do recem-criado, que e o proximo passo obvio.
        openTimerId = response.timerId;
        selectedTimerId = response.timerId;
      },
    );
  }

  function moveSelected(offset) {
    if (selectedTimerId) socket.emit("timer:move", selectedTimerId, offset);
  }

  function removeSelected() {
    const timer = findTimer(selectedTimerId);
    if (!timer) return;
    if (!window.confirm(`Remover "${getTimerLabel(timer)}" da sessão?`)) return;
    socket.emit("timer:remove", timer.id);
  }

  function emitUpdate(payload) {
    if (selectedTimerId) socket.emit("timer:update", selectedTimerId, payload);
  }

  function readTimeMs() {
    return (
      (readNumber(ui.cfgH, 0, MAX_TIMER_HOURS) * 3600 +
        readNumber(ui.cfgM, 0, 59) * 60 +
        readNumber(ui.cfgS, 0, 59)) *
      1000
    );
  }

  function fillTimeInputs(ms) {
    const { hours, minutes, seconds } = splitDuration(ms);
    ui.cfgH.value = String(hours);
    ui.cfgM.value = String(minutes);
    ui.cfgS.value = String(seconds);
  }

  function fillOffsetInputs(ms) {
    const { hours, minutes, seconds } = splitDuration(ms);
    ui.cfgOffH.value = String(hours);
    ui.cfgOffM.value = String(minutes);
    ui.cfgOffS.value = String(seconds);
  }

  /**
   * @param {boolean} iniciar tambem da Start, poupando o passo extra que era
   * a reclamacao principal: definir o tempo e sair procurando o botao.
   */
  function applyTime(iniciar) {
    const ms = readTimeMs();

    if (ms < 1000 || ms > MAX_TIMER_MS) {
      return showFeedback(
        `Informe um tempo entre 1 segundo e ${MAX_TIMER_HOURS} horas.`,
        "error",
      );
    }

    emitUpdate({ totalTime: ms });
    if (iniciar) startSelected();
    showFeedback(
      iniciar ? "Tempo aplicado e cronômetro iniciado." : "Tempo aplicado.",
      "success",
    );
  }

  function startSelected() {
    if (selectedTimerId) socket.emit("timer:start", selectedTimerId);
  }

  /**
   * Converte o horario informado em quanto ja correu ate agora. Se o horario
   * ainda nao chegou hoje, entende-se que foi ontem.
   */
  function fillFromClock() {
    const valor = ui.cfgClock?.value;
    if (!valor) {
      return showFeedback("Informe o horário em que começou.", "error");
    }

    const [horas, minutos] = valor.split(":").map(Number);
    const inicio = new Date();
    inicio.setHours(horas, minutos, 0, 0);
    if (inicio.getTime() > Date.now()) {
      inicio.setDate(inicio.getDate() - 1);
    }

    const decorrido = Date.now() - inicio.getTime();
    fillOffsetInputs(decorrido);
    ui.clockHint.textContent = `Dá ${formatTime(decorrido)} até agora.`;
  }

  function readOffsetMs() {
    return (
      (readNumber(ui.cfgOffH, 0, MAX_TIMER_HOURS) * 3600 +
        readNumber(ui.cfgOffM, 0, 59) * 60 +
        readNumber(ui.cfgOffS, 0, 59)) *
      1000
    );
  }

  function applyOffset(ms, iniciar) {
    const timer = findTimer(selectedTimerId);
    if (!timer) return;

    if (ms > timer.totalTime - 1000) {
      return showFeedback(
        `O valor precisa ser menor que ${formatTime(timer.totalTime)}.`,
        "error",
      );
    }

    emitUpdate({ offsetMs: ms });
    if (iniciar) startSelected();

    const rotulo = timer.direction === "up" ? "Decorrido" : "Consumido";
    showFeedback(
      ms > 0
        ? `${rotulo} definido em ${formatTime(ms)}${iniciar ? " e iniciado" : ""}.`
        : "Voltou para zero.",
      "success",
    );
  }

  function applyAccrual() {
    if (!ui.accrualEnabled.checked) {
      ui.accrualSentence.dataset.enabled = "false";
      return emitUpdate({ accrual: null });
    }

    ui.accrualSentence.dataset.enabled = "true";

    const everyMs =
      (readNumber(ui.accrualEveryH, 0, 99) * 3600 +
        readNumber(ui.accrualEveryM, 0, 59) * 60) *
      1000;
    const addMs = readNumber(ui.accrualAddM, 0, 599) * 60 * 1000;
    const sourceTimerId = ui.accrualSource.value;

    if (everyMs < MIN_ACCRUAL_EVERY_MS) {
      return showFeedback("O intervalo da regra precisa ser de ao menos 1 minuto.", "error");
    }
    if (addMs < 1000) {
      return showFeedback("Informe quantos minutos somar.", "error");
    }
    if (!sourceTimerId) {
      return showFeedback("Escolha o cronômetro que dispara a regra.", "error");
    }

    emitUpdate({ accrual: { sourceTimerId, everyMs, addMs } });
  }

  // ------------------------------------------------------ modal de config

  function toggleConfig(timerId) {
    if (openTimerId === timerId) return closeConfig();

    openTimerId = timerId;
    selectedTimerId = timerId;
    placeConfig(true);
  }

  function closeConfig() {
    openTimerId = null;
    ui.config.hidden = true;
    // Fora dos blocos o painel nao interfere no grid dos secundarios.
    document.body.appendChild(ui.config);
    syncConfigToggles();
  }

  /**
   * Move o painel para dentro do bloco aberto. Quando a faixa de secundarios
   * e reconstruida o bloco anfitriao some junto, entao a cada estado o painel
   * e reposicionado.
   */
  function placeConfig(selectionChanged) {
    const timer = findTimer(openTimerId);
    if (!timer) {
      if (openTimerId) closeConfig();
      return;
    }

    const host =
      timer.id === state.primaryTimerId
        ? ui.primaryBlock
        : minis.get(timer.id)?.root;

    if (!host) return;

    if (ui.config.parentElement !== host) host.appendChild(ui.config);
    ui.config.hidden = false;
    ui.configTitle.textContent = `Ajustes · ${getTimerLabel(timer)}`;

    if (selectionChanged) fillConfigForm(timer);
    syncConfigLive(timer);
    syncConfigToggles();
  }

  function syncConfigToggles() {
    for (const button of document.querySelectorAll('[data-action="config"]')) {
      const id = button.closest("[data-timer-id]")?.dataset.timerId;
      const aberto = Boolean(id) && id === openTimerId;
      button.setAttribute("aria-expanded", String(aberto));
      button.textContent = aberto ? "Fechar ajustes" : "Ajustar";
    }
  }

  function fillConfigForm(timer) {
    ui.cfgName.value = timer.name;

    for (const button of ui.config.querySelectorAll("[data-direction]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.direction === timer.direction),
      );
    }

    fillTimeInputs(timer.baseTotalTime);
    fillOffsetInputs(timer.offsetMs);
    if (ui.clockHint) ui.clockHint.textContent = "";

    fillAccrualForm(timer);
  }

  function fillAccrualForm(timer) {
    const others = state.timers.filter((item) => item.id !== timer.id);

    ui.accrualSource.replaceChildren();
    for (const other of others) {
      const option = document.createElement("option");
      option.value = other.id;
      option.textContent = getTimerLabel(other);
      ui.accrualSource.appendChild(option);
    }

    const rule = timer.accrual;
    ui.accrualEnabled.checked = Boolean(rule);
    ui.accrualEnabled.disabled = others.length === 0;
    ui.accrualSentence.dataset.enabled = String(Boolean(rule));

    if (rule) {
      const every = splitDuration(rule.everyMs);
      ui.accrualEveryH.value = String(every.hours);
      ui.accrualEveryM.value = String(every.minutes);
      ui.accrualAddM.value = String(Math.round(rule.addMs / 60000));
      ui.accrualSource.value = rule.sourceTimerId;
      return;
    }

    ui.accrualEveryH.value = "1";
    ui.accrualEveryM.value = "0";
    ui.accrualAddM.value = "5";
    if (others.length) ui.accrualSource.value = others[0].id;
  }

  /** Partes do formulario que refletem o estado e podem mudar a cada tick. */
  function syncConfigLive(timer) {
    const isPrimary = timer.id === state.primaryTimerId;
    const running = timer.status === "running";

    // Os mesmos campos servem aos dois modos, mas o nome muda o sentido:
    // num progressivo o valor e o que ja correu; num regressivo, o que ja foi
    // gasto. Chamar os dois de "comecar em" era o que confundia.
    const progressivo = timer.direction === "up";

    ui.cfgDirectionHint.textContent = progressivo
      ? "Conta para cima e mostra quanto já passou. O tempo abaixo é a meta."
      : "Conta para baixo e mostra quanto falta. O tempo abaixo é a duração.";

    ui.cfgTimeLabel.textContent = progressivo ? "Meta" : "Duração";
    ui.cfgOffsetLabel.textContent = progressivo
      ? "Já decorrido"
      : "Já consumido";
    ui.clockLabel.textContent = progressivo
      ? "ou começou às"
      : "ou está correndo desde";
    ui.clockRow.hidden = false;

    ui.applyTime.disabled = running;
    ui.applyStart.disabled = running;
    ui.cfgTimeHint.textContent = running
      ? "Pause o cronômetro para trocar o tempo."
      : "Trocar o tempo zera a contagem deste cronômetro.";

    ui.applyOffset.disabled = running;
    ui.offsetStart.disabled = running;
    ui.clearOffset.disabled = running || timer.offsetMs === 0;
    ui.cfgOffsetHint.textContent = running
      ? `Pause para ajustar ${progressivo ? "o decorrido" : "o consumido"}.`
      : timer.offsetMs > 0
        ? `Parte de ${formatTime(timer.offsetMs)}. O Reset volta para cá, não para zero.`
        : progressivo
          ? "Use quando a contagem já vem de antes — ex.: a aula corre há 05:15:00."
          : "Use para registrar o que já foi gasto sem o cronômetro rodando.";

    ui.setPrimary.disabled = isPrimary;
    ui.setPrimary.textContent = isPrimary
      ? "Já é o destaque"
      : "Destacar no viewer";
    ui.moveUp.disabled = timer.index === 0;
    ui.moveDown.disabled = timer.index === state.timers.length - 1;

    const rule = timer.accrual;
    if (!rule) {
      ui.accrualStatus.textContent = state.timers.length < 2
        ? "Adicione outro cronômetro para poder usar esta regra."
        : "";
      return;
    }

    const source = findTimer(rule.sourceTimerId);
    const frase = getAccrualLabel(rule, source ? getTimerLabel(source) : "?");
    ui.accrualStatus.textContent = timer.bonusMs
      ? `${frase} · já somou ${formatCompactDuration(timer.bonusMs)} em ${rule.grantedCount}x`
      : frase;
  }

  function openModal() {
    ui.overlay.classList.add("open");
    renderModels();
  }

  function closeModal() {
    ui.overlay.classList.remove("open");
  }

  // ---------------------------------------------------------------- modelos

  function loadModels() {
    try {
      const raw =
        localStorage.getItem(MODELS_KEY) ??
        localStorage.getItem(legacyPresetsKey);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed.map(sanitizeModel).filter(Boolean).slice(0, MAX_MODELS);
    } catch {
      return [];
    }
  }

  function sanitizeModel(raw) {
    if (!raw || typeof raw !== "object") return null;

    const name = sanitizeTimerName(raw.name);
    const secs = Math.trunc(Number(raw.secs));
    if (!name || !Number.isFinite(secs) || secs < 1 || secs > MAX_TIMER_MS / 1000) {
      return null;
    }

    return { name, secs, direction: raw.direction === "up" ? "up" : "down" };
  }

  function saveModelFromSelected() {
    const timer = findTimer(selectedTimerId);
    if (!timer) return;

    const name = sanitizeTimerName(ui.cfgName.value) || getTimerLabel(timer);
    const models = loadModels().filter(
      (item) => item.name.toLowerCase() !== name.toLowerCase(),
    );

    models.push({
      name,
      secs: Math.round(timer.baseTotalTime / 1000),
      direction: timer.direction,
    });

    try {
      localStorage.setItem(MODELS_KEY, JSON.stringify(models.slice(-MAX_MODELS)));
    } catch {
      return showFeedback("Não foi possível salvar o modelo.", "error");
    }

    renderModels();
    showFeedback(`Modelo "${name}" salvo.`, "success");
  }

  function deleteModel(index) {
    const models = loadModels();
    models.splice(index, 1);
    try {
      localStorage.setItem(MODELS_KEY, JSON.stringify(models));
    } catch {
      /* nada a fazer alem de manter a tela como esta */
    }
    renderModels();
  }

  function renderModels() {
    const models = loadModels();

    ui.modelsChips.replaceChildren();
    if (!models.length) {
      const vazio = document.createElement("span");
      vazio.className = "presets-empty-d";
      vazio.textContent = "Salve um cronômetro como modelo nas configurações";
      ui.modelsChips.appendChild(vazio);
    } else {
      for (const model of models) {
        const chip = document.createElement("button");
        chip.className = "preset-chip-d";
        chip.type = "button";
        chip.textContent = `${model.name} · ${formatCompactDuration(model.secs * 1000)} ${
          model.direction === "up" ? "↑" : "↓"
        }`;
        chip.title = `Adicionar cronômetro a partir de "${model.name}"`;
        chip.addEventListener("click", () => addTimer(model));
        ui.modelsChips.appendChild(chip);
      }
    }

    if (!ui.modelsManage) return;
    ui.modelsManage.replaceChildren();

    if (!models.length) {
      const vazio = document.createElement("div");
      vazio.className = "presets-empty";
      vazio.textContent = "Nenhum modelo salvo ainda.";
      ui.modelsManage.appendChild(vazio);
      return;
    }

    models.forEach((model, index) => {
      const row = document.createElement("div");
      row.className = "preset-manage-row";

      const info = document.createElement("div");
      info.className = "preset-manage-info";

      const name = document.createElement("div");
      name.className = "preset-manage-name";
      name.textContent = model.name;

      const time = document.createElement("div");
      time.className = "preset-manage-time";
      time.textContent = `${formatCompactDuration(model.secs * 1000)} · ${
        model.direction === "up" ? "progressivo" : "regressivo"
      }`;

      const del = document.createElement("button");
      del.className = "preset-del-btn";
      del.type = "button";
      del.textContent = "✕";
      del.setAttribute("aria-label", `Excluir modelo ${model.name}`);
      del.addEventListener("click", () => deleteModel(index));

      info.append(name, time);
      row.append(info, del);
      ui.modelsManage.appendChild(row);
    });
  }

  // ------------------------------------------------------------------ apoio

  function findTimer(timerId) {
    if (!timerId) return null;
    return state.timers.find((timer) => timer.id === timerId) || null;
  }

  function readNumber(input, min, max) {
    const parsed = Number.parseInt(input?.value ?? "", 10);
    const safe = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, parsed))
      : min;
    if (input) input.value = String(safe);
    return safe;
  }

  function statusLabel(status) {
    if (status === "running") return "RODANDO";
    if (status === "paused") return "PAUSADO";
    if (status === "finished") return "FINALIZADO";
    return "PARADO";
  }

  function syncWatchers() {
    const present = new Set(state.timers.map((timer) => timer.id));
    for (const id of finishWatchers.keys()) {
      if (!present.has(id)) finishWatchers.delete(id);
    }

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

  function setAuthFeedback(message) {
    if (ui.authFeedback) ui.authFeedback.textContent = message;
  }

  function showFeedback(message, kind) {
    window.clearTimeout(feedbackTimer);
    ui.boardFeedback.textContent = message;
    ui.boardFeedback.dataset.state = kind;

    feedbackTimer = window.setTimeout(() => {
      ui.boardFeedback.textContent = "";
      delete ui.boardFeedback.dataset.state;
    }, FEEDBACK_MS);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      return;
    }
    document.exitFullscreen().catch(() => {});
  }

  function syncFullscreen() {
    if (!ui.fullscreen) return;
    ui.fullscreen.textContent = document.fullscreenElement ? "✕" : "FS";
  }

  function showError(message) {
    socket.disconnect();
    document.body.classList.add("message-mode");
    const box = document.createElement("div");
    box.className = "screen-message";
    box.textContent = message;
    document.body.replaceChildren(box);
  }
})();
