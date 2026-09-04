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
  getRemaining,
  isTimerFinished,
  pauseTimer,
  resetTimer,
  sanitizeDirection,
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
  sessionIdPattern,
  sessionTtlMs,
  timerIdPattern,
}) {
  const sessions = new Map();

  return {
    addTimer,
    broadcastSession,
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

    syncSessionInterval(session);
    return true;
  }

  /**
   * Nome e direcao mudam a qualquer momento porque so afetam a apresentacao.
   * O tempo total so muda com o cronometro fora do "running" e zera a
   * contagem, evitando um estado em que o decorrido ja passou do novo total.
   */
  function updateTimer(session, timerId, { direction, name, totalTime } = {}) {
    const timer = getTimer(session, timerId);
    if (!timer) return false;

    let changed = false;

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
        resetTimer(timer);
        changed = true;
      }
    }

    return changed;
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
