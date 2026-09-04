const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createSessionStore } = require("../src/sessions");

const SESSION_ID_PATTERN = /^[a-f0-9]{8}$/i;
const ADMIN_TOKEN_PATTERN = /^[a-f0-9]{36}$/i;
const TIMER_ID_PATTERN = /^[a-f0-9]{6}$/i;
const DEFAULT_TIMER_MS = 5 * 60 * 1000;
const MAX_TIMER_MS = 100 * 60 * 60 * 1000;
const MAX_TIMERS_PER_SESSION = 12;
const MAX_TIMER_NAME_LENGTH = 24;
const SESSION_TTL_MS = 60 * 1000;

/**
 * Coleta as emissoes para inspecao, no lugar do io real do Socket.IO.
 * `rooms` alimenta a regra de "sessao com cliente conectado nao expira".
 */
function createFakeIo(rooms = new Map()) {
  const emissions = [];
  return {
    emissions,
    sockets: { adapter: { rooms } },
    rooms,
    to(room) {
      return {
        emit(event, payload) {
          emissions.push({ room, event, payload });
        },
      };
    },
  };
}

function createStore(io = createFakeIo()) {
  const store = createSessionStore({
    adminTokenPattern: ADMIN_TOKEN_PATTERN,
    defaultTimerMs: DEFAULT_TIMER_MS,
    io,
    maxTimerMs: MAX_TIMER_MS,
    maxTimerNameLength: MAX_TIMER_NAME_LENGTH,
    maxTimersPerSession: MAX_TIMERS_PER_SESSION,
    sessionIdPattern: SESSION_ID_PATTERN,
    sessionTtlMs: SESSION_TTL_MS,
    timerIdPattern: TIMER_ID_PATTERN,
  });
  return { store, io };
}

/** Evita que o setInterval do tick segure o processo de teste aberto. */
function stopSession(store, session) {
  store.clearSessionInterval(session);
}

describe("createSession", () => {
  it("gera id e token validos com um cronometro parado em destaque", () => {
    const { store } = createStore();
    const session = store.createSession();

    assert.match(session.id, SESSION_ID_PATTERN);
    assert.match(session.adminToken, ADMIN_TOKEN_PATTERN);
    assert.equal(session.timers.length, 1);
    assert.equal(session.timers[0].status, "stopped");
    assert.equal(session.timers[0].totalTime, DEFAULT_TIMER_MS);
    assert.equal(session.primaryTimerId, session.timers[0].id);
  });

  it("registra a sessao para consulta posterior", () => {
    const { store } = createStore();
    const session = store.createSession();
    assert.equal(store.getSession(session.id), session);
  });
});

describe("validacoes", () => {
  const { store } = createStore();

  it("isValidSessionId", () => {
    assert.equal(store.isValidSessionId("a1b2c3d4"), true);
    assert.equal(store.isValidSessionId("xyz"), false);
    assert.equal(store.isValidSessionId(123), false);
  });

  it("isValidAdminToken", () => {
    assert.equal(store.isValidAdminToken("a".repeat(36)), true);
    assert.equal(store.isValidAdminToken("a".repeat(10)), false);
  });

  it("isValidTimerId", () => {
    assert.equal(store.isValidTimerId("a1b2c3"), true);
    assert.equal(store.isValidTimerId("a1b2c3d4"), false);
    assert.equal(store.isValidTimerId(null), false);
  });

  it("isValidRole aceita apenas admin e viewer", () => {
    assert.equal(store.isValidRole("admin"), true);
    assert.equal(store.isValidRole("viewer"), true);
    assert.equal(store.isValidRole("hacker"), false);
  });
});

describe("sanitizeTimerMs", () => {
  const { store } = createStore();

  it("aceita valores dentro do intervalo e trunca decimais", () => {
    assert.equal(store.sanitizeTimerMs(1500.9), 1500);
  });

  it("aceita as 80 horas da aula longa", () => {
    assert.equal(store.sanitizeTimerMs(80 * 60 * 60 * 1000), 288_000_000);
  });

  it("rejeita abaixo do minimo, acima do maximo e nao-numerico", () => {
    assert.equal(store.sanitizeTimerMs(999), null);
    assert.equal(store.sanitizeTimerMs(MAX_TIMER_MS + 1), null);
    assert.equal(store.sanitizeTimerMs("abc"), null);
    assert.equal(store.sanitizeTimerMs(Infinity), null);
  });
});

describe("addTimer", () => {
  it("acrescenta com nome, direcao e tempo informados", () => {
    const { store } = createStore();
    const session = store.createSession();

    const timer = store.addTimer(session, {
      name: "  Break  ",
      direction: "up",
      totalTime: 25 * 60 * 1000,
    });

    assert.equal(timer.name, "Break");
    assert.equal(timer.direction, "up");
    assert.equal(timer.totalTime, 25 * 60 * 1000);
    assert.equal(session.timers.length, 2);
  });

  it("cai no tempo padrao quando o valor e invalido", () => {
    const { store } = createStore();
    const session = store.createSession();

    assert.equal(store.addTimer(session, { totalTime: 10 }).totalTime, DEFAULT_TIMER_MS);
  });

  it("recusa acima do limite da sessao", () => {
    const { store } = createStore();
    const session = store.createSession();

    while (session.timers.length < MAX_TIMERS_PER_SESSION) {
      assert.ok(store.addTimer(session, {}));
    }

    assert.equal(store.addTimer(session, {}), null);
    assert.equal(session.timers.length, MAX_TIMERS_PER_SESSION);
  });
});

describe("removeTimer", () => {
  it("remove e reaponta o destaque para o primeiro restante", () => {
    const { store } = createStore();
    const session = store.createSession();
    const extra = store.addTimer(session, { name: "Break" });
    const first = session.timers[0];

    assert.equal(store.removeTimer(session, first.id), true);
    assert.equal(session.timers.length, 1);
    assert.equal(session.primaryTimerId, extra.id);
  });

  it("ignora id desconhecido", () => {
    const { store } = createStore();
    const session = store.createSession();
    assert.equal(store.removeTimer(session, "ffffff"), false);
  });
});

describe("updateTimer", () => {
  it("altera nome e direcao mesmo com o cronometro rodando", () => {
    const { store } = createStore();
    const session = store.createSession();
    const timer = session.timers[0];
    store.startSessionTimer(session, timer.id);

    assert.equal(
      store.updateTimer(session, timer.id, { name: "Aula", direction: "up" }),
      true,
    );
    assert.equal(timer.name, "Aula");
    assert.equal(timer.direction, "up");

    stopSession(store, session);
  });

  it("recusa trocar o tempo enquanto roda", () => {
    const { store } = createStore();
    const session = store.createSession();
    const timer = session.timers[0];
    store.startSessionTimer(session, timer.id);

    assert.equal(store.updateTimer(session, timer.id, { totalTime: 9000 }), false);
    assert.equal(timer.totalTime, DEFAULT_TIMER_MS);

    stopSession(store, session);
  });

  it("troca o tempo com o cronometro pausado e zera a contagem", () => {
    const { store } = createStore();
    const session = store.createSession();
    const timer = session.timers[0];
    timer.status = "paused";
    timer.elapsed = 4000;

    assert.equal(store.updateTimer(session, timer.id, { totalTime: 9000 }), true);
    assert.equal(timer.totalTime, 9000);
    assert.equal(timer.elapsed, 0);
    assert.equal(timer.status, "stopped");
  });
});

describe("setPrimaryTimer e moveTimer", () => {
  it("troca o destaque para outro cronometro da sessao", () => {
    const { store } = createStore();
    const session = store.createSession();
    const extra = store.addTimer(session, { name: "Break" });

    assert.equal(store.setPrimaryTimer(session, extra.id), true);
    assert.equal(session.primaryTimerId, extra.id);
    assert.equal(store.setPrimaryTimer(session, extra.id), false);
    assert.equal(store.setPrimaryTimer(session, "ffffff"), false);
  });

  it("move dentro dos limites da lista", () => {
    const { store } = createStore();
    const session = store.createSession();
    const first = session.timers[0];
    const second = store.addTimer(session, { name: "Break" });

    assert.equal(store.moveTimer(session, second.id, -1), true);
    assert.deepEqual(
      session.timers.map((timer) => timer.id),
      [second.id, first.id],
    );

    assert.equal(store.moveTimer(session, second.id, -1), false);
    assert.equal(store.moveTimer(session, first.id, 1), false);
  });
});

describe("bulkTimerAction", () => {
  it("inicia e pausa todos de uma vez", () => {
    const { store } = createStore();
    const session = store.createSession();
    store.addTimer(session, { name: "Break" });

    assert.equal(store.bulkTimerAction(session, "start"), true);
    assert.ok(session.timers.every((timer) => timer.status === "running"));

    assert.equal(store.bulkTimerAction(session, "pause"), true);
    assert.ok(session.timers.every((timer) => timer.status === "paused"));

    stopSession(store, session);
  });

  it("ignora acao desconhecida", () => {
    const { store } = createStore();
    const session = store.createSession();
    assert.equal(store.bulkTimerAction(session, "explodir"), false);
  });
});

describe("tick da sessao", () => {
  it("liga com o primeiro start e desliga quando o ultimo para", () => {
    const { store } = createStore();
    const session = store.createSession();
    const extra = store.addTimer(session, { name: "Break" });

    store.startSessionTimer(session, session.timers[0].id);
    store.startSessionTimer(session, extra.id);
    assert.ok(session.interval, "esperava um intervalo ativo");

    store.pauseSessionTimer(session, session.timers[0].id);
    assert.ok(session.interval, "ainda ha cronometro rodando");

    store.pauseSessionTimer(session, extra.id);
    assert.equal(session.interval, null);
  });
});

describe("broadcastSession", () => {
  it("marca como finished quando o tempo acaba e emite os dois eventos", () => {
    const { store, io } = createStore();
    const session = store.createSession();
    const timer = session.timers[0];
    timer.totalTime = 1000;
    timer.status = "running";
    timer.startTime = Date.now() - 5000;

    store.broadcastSession(session.id);

    assert.equal(timer.status, "finished");
    assert.equal(timer.startTime, null);

    const state = io.emissions.findLast((e) => e.event === "session:state");
    assert.equal(state.payload.timers[0].remaining, 0);
    assert.equal(state.payload.timers[0].status, "finished");

    const legacy = io.emissions.findLast((e) => e.event === "timer:tick");
    assert.equal(legacy.payload.remaining, 0);
    assert.equal(legacy.payload.status, "finished");
  });

  it("nao derruba um cronometro pelo termino de outro", () => {
    const { store } = createStore();
    const session = store.createSession();
    const longo = store.addTimer(session, {
      name: "Aula",
      totalTime: 80 * 60 * 60 * 1000,
    });

    const curto = session.timers[0];
    curto.totalTime = 1000;
    curto.status = "running";
    curto.startTime = Date.now() - 5000;
    store.startSessionTimer(session, longo.id);

    store.broadcastSession(session.id);

    assert.equal(curto.status, "finished");
    assert.equal(longo.status, "running");
    assert.ok(session.interval, "o tick segue vivo pelo cronometro longo");

    stopSession(store, session);
  });
});

describe("expiracao", () => {
  it("getSession remove e retorna null para sessao expirada", () => {
    const { store } = createStore();
    const session = store.createSession();
    session.lastAccessAt = Date.now() - (SESSION_TTL_MS + 1000);

    assert.equal(store.getSession(session.id), null);
    assert.equal(store.getSession(session.id), null);
  });

  it("mantem a sessao viva enquanto houver cliente conectado", () => {
    const rooms = new Map();
    const { store } = createStore(createFakeIo(rooms));
    const session = store.createSession();
    session.lastAccessAt = Date.now() - (SESSION_TTL_MS + 1000);
    rooms.set(session.id, new Set(["socket-1"]));

    assert.equal(store.getSession(session.id), session);

    rooms.delete(session.id);
    assert.equal(store.getSession(session.id), null);
  });

  it("listActiveSessions ignora as expiradas", () => {
    const { store } = createStore();
    const ativa = store.createSession();
    const expirada = store.createSession();
    expirada.lastAccessAt = Date.now() - (SESSION_TTL_MS + 1000);

    const ids = store.listActiveSessions().map((s) => s.id);
    assert.ok(ids.includes(ativa.id));
    assert.ok(!ids.includes(expirada.id));
  });

  it("listActiveSessions resume o status agregado da sessao", () => {
    const { store } = createStore();
    const session = store.createSession();
    store.addTimer(session, { name: "Break" });
    store.startSessionTimer(session, session.timers[1].id);

    const listed = store.listActiveSessions().find((s) => s.id === session.id);
    assert.equal(listed.status, "running");
    assert.equal(listed.timers.length, 2);
    assert.equal(listed.primaryTimerId, session.timers[0].id);

    stopSession(store, session);
  });
});

describe("closeSession", () => {
  it("emite session:closed e remove a sessao", () => {
    const { store, io } = createStore();
    const session = store.createSession();

    assert.equal(store.closeSession(session.id), true);
    assert.ok(
      io.emissions.some(
        (e) => e.room === session.id && e.event === "session:closed",
      ),
    );
    assert.equal(store.getSession(session.id), null);
  });

  it("retorna false para sessao inexistente", () => {
    const { store } = createStore();
    assert.equal(store.closeSession("ffffffff"), false);
  });
});
