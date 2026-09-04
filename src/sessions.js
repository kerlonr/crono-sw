/**
 * Armazenamento em memoria das sessoes.
 *
 * Cada sessao guarda uma lista ordenada de cronometros e o id daquele que vai
 * em destaque no viewer (`primaryTimerId`). O tick e unico por sessao: enquanto
 * houver ao menos um cronometro rodando, um `setInterval` transmite o estado
 * completo; quando o ultimo para, o intervalo e liberado.
 */
const { randomBytes } = require("crypto");

const {
  buildTimerState,
  createTimer,
  getElapsed,
  getRemaining,
  getStartElapsed,
  getTotalTime,
  isTimerFinished,
  pauseTimer,
  resetAccrual,
  resetTimer,
  sanitizeDirection,
  seekTimer,
  sanitizeTimerName,
  startTimer,
} = require("./timers");

const TICK_INTERVAL_MS = 250;

module.exports = {
  createSessionStore,
};

function createSessionStore({
  adminTokenPattern,
  defaultTimerMs,
  io,
  maxTimerMs,
  maxTimerNameLength,
  maxTimersPerSession,
  minAccrualAddMs,
  minAccrualEveryMs,
  sessionIdPattern,
  sessionTtlMs,
  timerIdPattern,
}) {
  const sessions = new Map();

  return {
    addTimer,
    applyAccruals,
    getSessionAuth,
    hasAuth,
    setSessionAuth,
    broadcastSession,
    exportSessions,
    importSessions,
    buildSessionState,
    bulkTimerAction,
    cleanupExpiredSessions,
    clearSessionInterval,
    closeSession,
    createSession,
    deleteSession,
    emitSessionState,
    getAdminSession,
    getPrimaryTimer,
    getRemaining,
    getSession,
    getTimer,
    isValidAdminToken,
    isValidRole,
    isValidSessionId,
    isValidTimerId,
    listActiveSessions,
    moveTimer,
    pauseSessionTimer,
    removeTimer,
    resetSessionTimer,
    sanitizeAccrual,
    sanitizeTimerMs,
    setPrimaryTimer,
    startSessionTimer,
    touchSession,
    updateTimer,
  };

  // ---------------------------------------------------------------- sessoes

  function createSession() {
    const now = Date.now();
    const id = createSessionId();
    const firstTimer = createTimer({
      existingIds: [],
      maxNameLength: maxTimerNameLength,
      totalTime: defaultTimerMs,
    });

    const session = {
      id,
      adminToken: randomBytes(18).toString("hex"),
      auth: null,
      timers: [firstTimer],
      primaryTimerId: firstTimer.id,
      interval: null,
      createdAt: now,
      lastAccessAt: now,
    };

    sessions.set(id, session);
    return session;
  }

  function createSessionId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = randomBytes(4).toString("hex");
      if (!sessions.has(id)) {
        return id;
      }
    }

    throw new Error("Unable to allocate a unique session id.");
  }

  function touchSession(session) {
    session.lastAccessAt = Date.now();
  }

  /**
   * Guarda as credenciais ja derivadas. A senha em si nunca chega aqui.
   * @param {object} session
   * @param {object|null} credentials
   */
  function setSessionAuth(session, credentials) {
    session.auth = credentials || null;
    return true;
  }

  function getSessionAuth(session) {
    return session.auth || null;
  }

  function hasAuth(session) {
    return Boolean(session.auth);
  }

  // Uma aula de 80 horas pode ficar horas em pausa sem gerar tick nenhum, entao
  // o TTL sozinho derrubaria a sessao com o admin ainda com a aba aberta.
  //
  // Duas condicoes salvam a sessao mesmo com o TTL vencido:
  //   - ha cliente conectado;
  //   - ha cronometro rodando. Em uso normal o tick renova o TTL a cada 250ms,
  //     mas se a maquina suspender ou o processo ficar travado por mais tempo
  //     que o TTL, o primeiro tick apos a volta encontraria a sessao vencida e
  //     apagaria uma contagem em andamento. Um cronometro rodando e, por
  //     definicao, uma sessao viva.
  function isSessionExpired(session) {
    if (Date.now() - session.lastAccessAt <= sessionTtlMs) {
      return false;
    }

    if (session.timers.some((timer) => timer.status === "running")) {
      return false;
    }

    return !hasConnectedClients(session.id);
  }

  function hasConnectedClients(sessionId) {
    const room = io.sockets?.adapter?.rooms?.get(sessionId);
    return Boolean(room && room.size > 0);
  }

  function cleanupExpiredSessions() {
    for (const [sessionId, session] of sessions.entries()) {
      if (isSessionExpired(session)) {
        deleteSession(sessionId);
      }
    }
  }

  function deleteSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;

    clearSessionInterval(session);
    sessions.delete(sessionId);
  }

  function closeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || isSessionExpired(session)) {
      deleteSession(sessionId);
      return false;
    }

    io.to(sessionId).emit("session:closed");
    deleteSession(sessionId);
    return true;
  }

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || isSessionExpired(session)) {
      deleteSession(sessionId);
      return null;
    }

    return session;
  }

  function getAdminSession(socket) {
    if (!socket.isAdmin || !isValidSessionId(socket.currentSession)) {
      return null;
    }

    const session = getSession(socket.currentSession);
    if (!session) return null;

    touchSession(session);
    return session;
  }

  function listActiveSessions() {
    return Array.from(sessions.values())
      .filter((session) => !isSessionExpired(session))
      .map((session) => ({
        id: session.id,
        ...buildSessionState(session),
        status: getSessionStatus(session),
        hasAuth: hasAuth(session),
        createdAt: session.createdAt,
        lastAccessAt: session.lastAccessAt,
      }))
      .sort((left, right) => {
        const statusRank =
          getStatusRank(left.status) - getStatusRank(right.status);
        if (statusRank !== 0) {
          return statusRank;
        }

        return right.createdAt - left.createdAt;
      });
  }

  /** Status agregado da sessao, usado para ordenar e resumir na visao geral. */
  function getSessionStatus(session) {
    for (const status of ["running", "paused", "stopped"]) {
      if (session.timers.some((timer) => timer.status === status)) {
        return status;
      }
    }

    return session.timers.length ? "finished" : "stopped";
  }

  function getStatusRank(status) {
    switch (status) {
      case "running":
        return 0;
      case "paused":
        return 1;
      case "stopped":
        return 2;
      case "finished":
        return 3;
      default:
        return 4;
    }
  }

  /** Estado serializavel das sessoes, para o snapshot em disco. */
  function exportSessions() {
    return Array.from(sessions.values())
      .filter((session) => !isSessionExpired(session))
      .map((session) => ({
        id: session.id,
        adminToken: session.adminToken,
        auth: session.auth,
        primaryTimerId: session.primaryTimerId,
        createdAt: session.createdAt,
        lastAccessAt: session.lastAccessAt,
        timers: session.timers.map((timer) => ({
          id: timer.id,
          name: timer.name,
          direction: timer.direction,
          status: timer.status,
          elapsed: timer.elapsed,
          startTime: timer.startTime,
          totalTime: timer.totalTime,
          offsetMs: timer.offsetMs,
          bonusMs: timer.bonusMs,
          accrual: timer.accrual,
        })),
      }));
  }

  /**
   * Recarrega sessoes do snapshot. Cronometros que estavam rodando voltam
   * rodando com o `startTime` original, entao o tempo em que o processo ficou
   * fora do ar conta - a aula nao parou por causa do reinicio.
   *
   * @returns {number} quantas sessoes foram restauradas.
   */
  function importSessions(raw) {
    if (!Array.isArray(raw)) return 0;

    let restauradas = 0;

    for (const item of raw) {
      if (!item || !isValidSessionId(item.id) || sessions.has(item.id)) continue;
      if (!isValidAdminToken(item.adminToken)) continue;
      if (!Array.isArray(item.timers)) continue;

      const timers = item.timers
        .filter((timer) => timer && isValidTimerId(timer.id))
        .map((timer) => ({
          id: timer.id,
          name: sanitizeTimerName(timer.name, maxTimerNameLength),
          direction: sanitizeDirection(timer.direction),
          status: ["stopped", "running", "paused", "finished"].includes(
            timer.status,
          )
            ? timer.status
            : "stopped",
          elapsed: Math.max(0, Number(timer.elapsed) || 0),
          startTime: Number.isFinite(timer.startTime) ? timer.startTime : null,
          totalTime: sanitizeTimerMs(timer.totalTime) ?? defaultTimerMs,
          offsetMs: Math.max(0, Number(timer.offsetMs) || 0),
          bonusMs: Math.max(0, Number(timer.bonusMs) || 0),
          accrual: null,
        }))
        .slice(0, maxTimersPerSession);

      if (!timers.length) continue;

      const session = {
        id: item.id,
        adminToken: item.adminToken,
        auth: sanitizeStoredAuth(item.auth),
        timers,
        primaryTimerId: timers.some((t) => t.id === item.primaryTimerId)
          ? item.primaryTimerId
          : timers[0].id,
        interval: null,
        createdAt: Number(item.createdAt) || Date.now(),
        lastAccessAt: Date.now(),
      };

      sessions.set(session.id, session);

      // As regras entram depois, com a sessao ja montada, para a validacao
      // conseguir conferir que a fonte existe.
      for (const timer of item.timers) {
        if (!timer?.accrual) continue;
        const alvo = timers.find((t) => t.id === timer.id);
        if (!alvo) continue;

        alvo.accrual = sanitizeAccrual(session, alvo.id, timer.accrual);
        if (alvo.accrual) {
          alvo.accrual.grantedCount = Math.max(
            0,
            Math.trunc(Number(timer.accrual.grantedCount) || 0),
          );
        }
      }

      syncSessionInterval(session);
      restauradas += 1;
    }

    return restauradas;
  }

  // -------------------------------------------------------------- broadcast

  function buildSessionState(session) {
    return {
      timers: session.timers.map(buildTimerState),
      primaryTimerId: session.primaryTimerId,
    };
  }

  function getPrimaryTimer(session) {
    return (
      session.timers.find((timer) => timer.id === session.primaryTimerId) ||
      session.timers[0] ||
      null
    );
  }

  /**
   * Payload no formato antigo (um unico cronometro). Mantido para que abas do
   * viewer abertas antes do deploy continuem funcionando ate recarregarem.
   */
  function buildLegacyState(session) {
    const primary = getPrimaryTimer(session);
    if (!primary) {
      return { status: "stopped", remaining: 0, totalTime: 0, pct: 1 };
    }

    const { status, remaining, totalTime, pct } = buildTimerState(primary);
    return { status, remaining, totalTime, pct };
  }

  function broadcastSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;

    if (isSessionExpired(session)) {
      deleteSession(sessionId);
      return;
    }

    applyAccruals(session);
    finishDueTimers(session);
    syncSessionInterval(session);
    touchSession(session);

    io.to(sessionId).emit("session:state", buildSessionState(session));
    io.to(sessionId).emit("timer:tick", buildLegacyState(session));
  }

  function emitSessionState(target, session) {
    touchSession(session);
    target.emit("session:state", buildSessionState(session));
    target.emit("timer:tick", buildLegacyState(session));
  }

  /**
   * Concede o tempo ganho pelas regras de `accrual`.
   *
   * O contador de concessoes (`grantedCount`) e recalculado do decorrido da
   * fonte a cada tick, entao tick perdido, atraso ou reconexao nao duplicam
   * nem pulam um ganho.
   *
   * @returns {boolean} `true` se algum cronometro ganhou tempo agora.
   */
  function applyAccruals(session) {
    let changed = false;

    for (const timer of session.timers) {
      const rule = timer.accrual;
      if (!rule) continue;

      const source = session.timers.find(
        (item) => item.id === rule.sourceTimerId,
      );
      if (!source) continue;

      const earned = Math.floor(getElapsed(source) / rule.everyMs);
      if (earned === rule.grantedCount) continue;

      if (earned > rule.grantedCount) {
        const ganho = (earned - rule.grantedCount) * rule.addMs;
        const teto = Math.max(0, maxTimerMs - timer.totalTime);
        timer.bonusMs = Math.min(timer.bonusMs + ganho, teto);

        // Um intervalo que tinha zerado volta a ficar disponivel, pausado,
        // para o admin decidir quando usar o tempo recem-ganho.
        if (timer.status === "finished" && getRemaining(timer) > 0) {
          timer.status = "paused";
        }
      }

      rule.grantedCount = earned;
      changed = true;
    }

    return changed;
  }

  function finishDueTimers(session) {
    for (const timer of session.timers) {
      if (timer.status === "running" && isTimerFinished(timer)) {
        timer.elapsed = timer.totalTime;
        timer.startTime = null;
        timer.status = "finished";
      }
    }
  }

  /** Liga o tick quando ha cronometro rodando e desliga quando nao ha mais. */
  function syncSessionInterval(session) {
    const hasRunning = session.timers.some(
      (timer) => timer.status === "running",
    );

    if (!hasRunning) {
      clearSessionInterval(session);
      return;
    }

    if (session.interval) return;

    const sessionId = session.id;
    session.interval = setInterval(
      () => broadcastSession(sessionId),
      TICK_INTERVAL_MS,
    );
    // O tick sozinho nao deve segurar o processo aberto: em producao quem
    // mantem o app vivo e o socket do servidor. Sem isso um tick esquecido
    // impede o encerramento (foi o que travou a suite de testes).
    session.interval.unref?.();
  }

  function clearSessionInterval(session) {
    if (!session.interval) return;
    clearInterval(session.interval);
    session.interval = null;
  }

  // ------------------------------------------------------------ cronometros

  function getTimer(session, timerId) {
    if (!isValidTimerId(timerId)) return null;
    return session.timers.find((timer) => timer.id === timerId) || null;
  }

  /**
   * @returns {object|null} o cronometro criado, ou `null` se o limite da
   * sessao foi atingido.
   */
  function addTimer(session, { direction, name, totalTime } = {}) {
    if (session.timers.length >= maxTimersPerSession) return null;

    const safeTotalTime = sanitizeTimerMs(totalTime) ?? defaultTimerMs;
    const timer = createTimer({
      direction,
      existingIds: session.timers.map((item) => item.id),
      maxNameLength: maxTimerNameLength,
      name,
      totalTime: safeTotalTime,
    });

    session.timers.push(timer);

    if (!getPrimaryTimer(session)) {
      session.primaryTimerId = timer.id;
    }

    return timer;
  }

  function removeTimer(session, timerId) {
    const index = session.timers.findIndex((timer) => timer.id === timerId);
    if (index === -1) return false;

    session.timers.splice(index, 1);

    if (session.primaryTimerId === timerId) {
      session.primaryTimerId = session.timers[0]?.id ?? null;
    }

    // Uma regra sem fonte nunca mais concederia nada; melhor desliga-la do
    // que deixar o admin com uma configuracao morta na tela.
    for (const restante of session.timers) {
      if (restante.accrual?.sourceTimerId === timerId) {
        restante.accrual = null;
      }
    }

    syncSessionInterval(session);
    return true;
  }

  /**
   * Nome e direcao mudam a qualquer momento porque so afetam a apresentacao.
   * O tempo total so muda com o cronometro fora do "running" e zera a
   * contagem, evitando um estado em que o decorrido ja passou do novo total.
   */
  function updateTimer(
    session,
    timerId,
    { accrual, direction, name, offsetMs, totalTime } = {},
  ) {
    const timer = getTimer(session, timerId);
    if (!timer) return false;

    let changed = false;

    if (accrual !== undefined) {
      timer.accrual = sanitizeAccrual(session, timerId, accrual);
      changed = true;
    }

    if (typeof name === "string") {
      timer.name = sanitizeTimerName(name, maxTimerNameLength);
      changed = true;
    }

    if (direction !== undefined) {
      timer.direction = sanitizeDirection(direction);
      changed = true;
    }

    if (totalTime !== undefined && timer.status !== "running") {
      const safeTotalTime = sanitizeTimerMs(totalTime);
      if (safeTotalTime !== null) {
        timer.totalTime = safeTotalTime;
        // O ponto de partida nao pode sobrar acima da nova duracao.
        timer.offsetMs = Math.min(timer.offsetMs, Math.max(0, safeTotalTime - 1000));
        resetTimer(timer);
        changed = true;
      }
    }

    if (offsetMs !== undefined && timer.status !== "running") {
      const safeOffset = sanitizeOffsetMs(timer, offsetMs);
      if (safeOffset !== null) {
        seekTimer(timer, safeOffset);
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Ponto de partida valido: de zero ate um segundo antes do total, para que
   * o cronometro sempre tenha ao menos um segundo para contar.
   */
  function sanitizeOffsetMs(timer, value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;

    const safeValue = Math.trunc(parsed);
    if (safeValue < 0 || safeValue > getTotalTime(timer) - 1000) return null;

    return safeValue;
  }

  function setPrimaryTimer(session, timerId) {
    if (!getTimer(session, timerId) || session.primaryTimerId === timerId) {
      return false;
    }

    session.primaryTimerId = timerId;
    return true;
  }

  /** Move o cronometro uma posicao para cima (offset < 0) ou para baixo. */
  function moveTimer(session, timerId, offset) {
    const index = session.timers.findIndex((timer) => timer.id === timerId);
    if (index === -1) return false;

    const target = index + (offset < 0 ? -1 : 1);
    if (target < 0 || target >= session.timers.length) return false;

    const [timer] = session.timers.splice(index, 1);
    session.timers.splice(target, 0, timer);
    return true;
  }

  function startSessionTimer(session, timerId) {
    const timer = getTimer(session, timerId);
    if (!timer || !startTimer(timer)) return false;

    syncSessionInterval(session);
    return true;
  }

  function pauseSessionTimer(session, timerId) {
    const timer = getTimer(session, timerId);
    if (!timer || !pauseTimer(timer)) return false;

    syncSessionInterval(session);
    return true;
  }

  function resetSessionTimer(session, timerId) {
    const timer = getTimer(session, timerId);
    if (!timer) return false;

    resetTimer(timer);

    // Zerar a fonte tambem zera o que ela concedeu: sem isso o bonus da
    // rodada anterior somaria com o da proxima.
    for (const dependente of session.timers) {
      if (dependente.accrual?.sourceTimerId === timerId) {
        resetAccrual(dependente);
      }
    }

    syncSessionInterval(session);
    return true;
  }

  /**
   * Aplica start/pause/reset em todos os cronometros da sessao de uma vez.
   * @returns {boolean} `true` se ao menos um cronometro mudou de estado.
   */
  function bulkTimerAction(session, action) {
    const apply = {
      start: startTimer,
      pause: pauseTimer,
      reset: (timer) => {
        resetTimer(timer);
        return true;
      },
    }[action];

    if (!apply) return false;

    let changed = false;
    for (const timer of session.timers) {
      if (apply(timer)) {
        changed = true;
      }
    }

    syncSessionInterval(session);
    return changed;
  }

  // ------------------------------------------------------------- validacoes

  /**
   * Valida uma regra de ganho. Recusa fonte inexistente e auto-referencia
   * (um cronometro alimentando a si mesmo cresceria sem limite).
   * @returns {object|null} regra normalizada, ou `null` para desligar.
   */
  /** Credenciais vindas do snapshot: so aceita o formato ja derivado. */
  function sanitizeStoredAuth(value) {
    if (!value || typeof value !== "object") return null;

    const { username, salt, hash } = value;
    if (typeof username !== "string" || !username) return null;
    if (typeof salt !== "string" || !/^[a-f0-9]+$/i.test(salt)) return null;
    if (typeof hash !== "string" || !/^[a-f0-9]+$/i.test(hash)) return null;

    return { username, salt, hash };
  }

  function sanitizeAccrual(session, timerId, value) {
    if (!value || typeof value !== "object") return null;

    const sourceTimerId = value.sourceTimerId;
    if (sourceTimerId === timerId) return null;
    if (!getTimer(session, sourceTimerId)) return null;

    const everyMs = sanitizeSpan(value.everyMs, minAccrualEveryMs);
    const addMs = sanitizeSpan(value.addMs, minAccrualAddMs);
    if (everyMs === null || addMs === null) return null;

    return { sourceTimerId, everyMs, addMs, grantedCount: 0 };
  }

  function sanitizeSpan(value, minimo) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;

    const safeValue = Math.trunc(parsed);
    if (safeValue < minimo || safeValue > maxTimerMs) return null;

    return safeValue;
  }

  function sanitizeTimerMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;

    const safeValue = Math.trunc(parsed);
    if (safeValue < 1000 || safeValue > maxTimerMs) {
      return null;
    }

    return safeValue;
  }

  function isValidSessionId(value) {
    return typeof value === "string" && sessionIdPattern.test(value);
  }

  function isValidAdminToken(value) {
    return typeof value === "string" && adminTokenPattern.test(value);
  }

  function isValidTimerId(value) {
    return typeof value === "string" && timerIdPattern.test(value);
  }

  function isValidRole(value) {
    return value === "admin" || value === "viewer";
  }
}
