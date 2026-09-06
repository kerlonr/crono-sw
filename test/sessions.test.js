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
const MIN_ACCRUAL_EVERY_MS = 60 * 1000;
const MIN_ACCRUAL_ADD_MS = 1000;

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
    minAccrualAddMs: MIN_ACCRUAL_ADD_MS,
    minAccrualEveryMs: MIN_ACCRUAL_EVERY_MS,
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

describe("ponto de partida", () => {
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  /** Cenario do usuario: meta de 80h com a aula ja correndo ha 5h15. */
  function cenario() {
    const { store } = createStore();
    const session = store.createSession();
    const timer = session.timers[0];
    store.updateTimer(session, timer.id, {
      name: "Decorrido",
      direction: "up",
      totalTime: 80 * HOUR,
    });
    return { store, session, timer };
  }

  it("parte do ponto informado em vez do zero", () => {
    const { store, session, timer } = cenario();

    assert.equal(
      store.updateTimer(session, timer.id, { offsetMs: 5 * HOUR + 15 * MIN }),
      true,
    );

    assert.equal(timer.elapsed, 5 * HOUR + 15 * MIN);
    assert.equal(store.getRemaining(timer), 80 * HOUR - (5 * HOUR + 15 * MIN));

    const estado = store
      .buildSessionState(session)
      .timers.find((t) => t.id === timer.id);
    assert.equal(estado.elapsed, 5 * HOUR + 15 * MIN);
    assert.equal(estado.offsetMs, 5 * HOUR + 15 * MIN);
  });

  it("continua contando a partir dali quando inicia", () => {
    const { store, session, timer } = cenario();
    store.updateTimer(session, timer.id, { offsetMs: 5 * HOUR });
    store.startSessionTimer(session, timer.id);

    timer.startTime = Date.now() - 30 * MIN;
    const decorrido = store.buildSessionState(session).timers[0].elapsed;

    assert.ok(
      Math.abs(decorrido - (5 * HOUR + 30 * MIN)) < 100,
      `esperava ~5h30, veio ${decorrido}ms`,
    );

    stopSession(store, session);
  });

  it("Reset volta ao ponto de partida, nao a zero", () => {
    const { store, session, timer } = cenario();
    store.updateTimer(session, timer.id, { offsetMs: 5 * HOUR + 15 * MIN });

    store.startSessionTimer(session, timer.id);
    timer.startTime = Date.now() - 2 * HOUR;
    store.resetSessionTimer(session, timer.id);

    assert.equal(timer.elapsed, 5 * HOUR + 15 * MIN);
    assert.equal(timer.status, "stopped");
  });

  it("recusa valor negativo e mudanca enquanto roda", () => {
    const { store, session, timer } = cenario();

    assert.equal(store.updateTimer(session, timer.id, { offsetMs: -1 }), false);

    store.startSessionTimer(session, timer.id);
    assert.equal(
      store.updateTimer(session, timer.id, { offsetMs: HOUR }),
      false,
      "rodando nao muda",
    );
    stopSession(store, session);
  });

  it("aceita consumo igual ao total, zerando o restante", () => {
    const { store, session, timer } = cenario();

    assert.equal(
      store.updateTimer(session, timer.id, { offsetMs: 80 * HOUR }),
      true,
      "informar que consumiu tudo e uma resposta valida",
    );
    assert.equal(store.getRemaining(timer), 0);
  });

  it("encolher a duracao preserva o consumo registrado", () => {
    const { store, session, timer } = cenario();
    store.updateTimer(session, timer.id, { offsetMs: 5 * HOUR });

    store.updateTimer(session, timer.id, { totalTime: 2 * HOUR });

    assert.equal(
      timer.offsetMs,
      5 * HOUR,
      "o consumo real nao e reescrito pela nova duracao",
    );
    assert.equal(
      store.getRemaining(timer),
      0,
      "5h consumidas de uma duracao de 2h nao deixam tempo a contar",
    );

    const estado = store
      .buildSessionState(session)
      .timers.find((t) => t.id === timer.id);
    assert.equal(estado.overspentMs, 3 * HOUR);
  });

  it("zerar o ponto de partida devolve a contagem ao zero", () => {
    const { store, session, timer } = cenario();
    store.updateTimer(session, timer.id, { offsetMs: 5 * HOUR });
    store.updateTimer(session, timer.id, { offsetMs: 0 });

    assert.equal(timer.offsetMs, 0);
    assert.equal(timer.elapsed, 0);
  });
});

describe("regra de ganho de tempo", () => {
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  /** Aula de 80h que concede 5min de intervalo a cada hora corrida. */
  function cenarioAula() {
    const { store } = createStore();
    const session = store.createSession();
    const aula = session.timers[0];
    store.updateTimer(session, aula.id, { name: "Aula", totalTime: 80 * HOUR });

    const intervalo = store.addTimer(session, {
      name: "Break",
      totalTime: 25 * MIN,
    });
    store.updateTimer(session, intervalo.id, {
      accrual: { sourceTimerId: aula.id, everyMs: HOUR, addMs: 5 * MIN },
    });

    return { store, session, aula, intervalo };
  }

  /** Coloca a fonte com um decorrido simulado, sem esperar o tempo real. */
  function correr(aula, ms) {
    aula.status = "running";
    aula.startTime = Date.now() - ms;
  }

  it("concede 5min a cada hora corrida da fonte", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 3 * HOUR + 5 * MIN);
    store.applyAccruals(session);

    assert.equal(intervalo.bonusMs, 15 * MIN);
    assert.equal(intervalo.totalTime, 25 * MIN, "a duracao configurada nao muda");
    assert.equal(store.getRemaining(intervalo), 40 * MIN);
  });

  it("nao concede antes de fechar o intervalo da regra", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 59 * MIN);
    store.applyAccruals(session);

    assert.equal(intervalo.bonusMs, 0);
  });

  it("e idempotente: reaplicar no mesmo instante nao duplica", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 2 * HOUR);
    store.applyAccruals(session);
    store.applyAccruals(session);
    store.applyAccruals(session);

    assert.equal(intervalo.bonusMs, 10 * MIN);
  });

  it("recupera ganhos de ticks perdidos de uma vez so", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    // Salto de 4 horas entre um tick e outro, como numa suspensao da maquina.
    correr(aula, 4 * HOUR);
    store.applyAccruals(session);

    assert.equal(intervalo.bonusMs, 20 * MIN);
    assert.equal(intervalo.accrual.grantedCount, 4);
  });

  it("um intervalo ja finalizado volta a ficar disponivel ao ganhar tempo", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    intervalo.status = "finished";
    intervalo.elapsed = 25 * MIN;

    correr(aula, HOUR);
    store.applyAccruals(session);

    assert.equal(intervalo.status, "paused");
    assert.equal(store.getRemaining(intervalo), 5 * MIN);
  });

  it("zerar a fonte descarta o bonus que ela concedeu", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 3 * HOUR);
    store.applyAccruals(session);
    assert.equal(intervalo.bonusMs, 15 * MIN);

    store.resetSessionTimer(session, aula.id);

    assert.equal(intervalo.bonusMs, 0);
    assert.equal(intervalo.accrual.grantedCount, 0);
    assert.equal(intervalo.accrual.sourceTimerId, aula.id, "a regra continua ligada");
  });

  it("reaplicar a mesma regra nao duplica o tempo ja ganho", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 5 * HOUR);
    store.applyAccruals(session);
    assert.equal(intervalo.bonusMs, 25 * MIN);

    // Mexer em qualquer campo da regra no painel reenvia a regra inteira.
    store.updateTimer(session, intervalo.id, {
      accrual: { sourceTimerId: aula.id, everyMs: HOUR, addMs: 5 * MIN },
    });
    store.applyAccruals(session);

    assert.equal(intervalo.bonusMs, 25 * MIN, "o bonus nao pode dobrar");
    assert.equal(intervalo.accrual.grantedCount, 5);
  });

  it("descontar o que ja foi consumido do intervalo", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 5 * HOUR);
    store.applyAccruals(session);
    assert.equal(store.getRemaining(intervalo), 50 * MIN, "25min de base + 25 ganhos");

    assert.equal(
      store.updateTimer(session, intervalo.id, { offsetMs: 12 * MIN }),
      true,
    );

    assert.equal(store.getRemaining(intervalo), 38 * MIN);
    assert.equal(intervalo.bonusMs, 25 * MIN, "descontar nao apaga o ganho");
  });

  it("aplicar duracao e consumo juntos preserva o tempo ganho", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 5 * HOUR);
    store.applyAccruals(session);

    // O painel manda os dois campos numa unica atualizacao.
    store.updateTimer(session, intervalo.id, {
      totalTime: 25 * MIN,
      offsetMs: 12 * MIN,
    });

    assert.equal(intervalo.bonusMs, 25 * MIN);
    assert.equal(intervalo.offsetMs, 12 * MIN);
    assert.equal(store.getRemaining(intervalo), 38 * MIN);
  });

  it("consumo acima do ganho vira divida e e abatido pelo ganho seguinte", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, HOUR);
    store.applyAccruals(session);
    assert.equal(store.getRemaining(intervalo), 30 * MIN, "25min de base + 5 ganhos");

    // Gastou 45min de intervalo, mais do que os 30 disponiveis.
    store.updateTimer(session, intervalo.id, { offsetMs: 45 * MIN });

    let estado = store
      .buildSessionState(session)
      .timers.find((t) => t.id === intervalo.id);
    assert.equal(estado.remaining, 0);
    assert.equal(estado.overspentMs, 15 * MIN, "15min no vermelho");

    // Na 4a hora o total chega a 45min e a divida acaba de ser quitada.
    correr(aula, 4 * HOUR);
    store.applyAccruals(session);

    estado = store
      .buildSessionState(session)
      .timers.find((t) => t.id === intervalo.id);
    assert.equal(estado.overspentMs, 0);
    assert.equal(estado.remaining, 0, "quitou, mas ainda nao sobrou nada");
    assert.equal(intervalo.elapsed, 45 * MIN, "o consumo entrou na contagem");

    // Da hora seguinte em diante o ganho e saldo livre de verdade.
    correr(aula, 5 * HOUR);
    store.applyAccruals(session);

    estado = store
      .buildSessionState(session)
      .timers.find((t) => t.id === intervalo.id);
    assert.equal(estado.remaining, 5 * MIN);
  });

  it("um cronometro com bonus termina zerado, sem tempo fantasma", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 3 * HOUR);
    store.applyAccruals(session);

    intervalo.status = "running";
    intervalo.elapsed = 40 * MIN;
    intervalo.startTime = Date.now();
    store.broadcastSession(session.id);

    assert.equal(intervalo.status, "finished");
    assert.equal(store.getRemaining(intervalo), 0);
  });

  it("Reset limpa a divida para a rodada nova comecar cheia", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 2 * HOUR);
    store.applyAccruals(session);
    store.updateTimer(session, intervalo.id, { offsetMs: 35 * MIN });

    store.resetSessionTimer(session, intervalo.id);

    assert.equal(intervalo.bonusMs, 0);
    assert.equal(
      intervalo.offsetMs,
      25 * MIN,
      "sobra o consumo que a propria duracao banca",
    );

    correr(aula, 3 * HOUR);
    store.applyAccruals(session);
    assert.equal(
      store.getRemaining(intervalo),
      5 * MIN,
      "a hora seguinte concede 5min livres, nao abate divida velha",
    );
  });

  it("remover a fonte desliga a regra em vez de deixa-la morta", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    store.removeTimer(session, aula.id);

    assert.equal(intervalo.accrual, null);
  });

  it("recusa auto-referencia, fonte inexistente e valores fora do limite", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    const regra = { sourceTimerId: aula.id, everyMs: HOUR, addMs: 5 * MIN };

    store.updateTimer(session, intervalo.id, {
      accrual: { ...regra, sourceTimerId: intervalo.id },
    });
    assert.equal(intervalo.accrual, null, "auto-referencia");

    store.updateTimer(session, intervalo.id, {
      accrual: { ...regra, sourceTimerId: "ffffff" },
    });
    assert.equal(intervalo.accrual, null, "fonte inexistente");

    store.updateTimer(session, intervalo.id, {
      accrual: { ...regra, everyMs: 1000 },
    });
    assert.equal(intervalo.accrual, null, "intervalo abaixo do minimo");

    store.updateTimer(session, intervalo.id, { accrual: null });
    assert.equal(intervalo.accrual, null, "null desliga a regra");
  });

  it("nao deixa o total efetivo passar do maximo do servidor", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    store.updateTimer(session, intervalo.id, { totalTime: 99 * HOUR });
    store.updateTimer(session, intervalo.id, {
      accrual: { sourceTimerId: aula.id, everyMs: HOUR, addMs: HOUR },
    });

    correr(aula, 40 * HOUR);
    store.applyAccruals(session);

    assert.ok(
      intervalo.totalTime + intervalo.bonusMs <= MAX_TIMER_MS,
      `total efetivo estourou: ${intervalo.totalTime + intervalo.bonusMs}`,
    );
  });

  it("o estado enviado separa duracao configurada de tempo ganho", () => {
    const { store, session, aula, intervalo } = cenarioAula();

    correr(aula, 2 * HOUR);
    store.applyAccruals(session);

    const estado = store
      .buildSessionState(session)
      .timers.find((t) => t.id === intervalo.id);

    assert.equal(estado.baseTotalTime, 25 * MIN);
    assert.equal(estado.bonusMs, 10 * MIN);
    assert.equal(estado.totalTime, 35 * MIN);
    assert.equal(estado.accrual.everyMs, HOUR);
    assert.equal(estado.accrual.addMs, 5 * MIN);
  });
});

describe("consumo e persistencia", () => {
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  it("informar consumo nao apaga o tempo ja ganho", () => {
    const { store } = createStore();
    const session = store.createSession();
    const aula = session.timers[0];
    store.updateTimer(session, aula.id, { name: "Aula", totalTime: 80 * HOUR });

    const intervalo = store.addTimer(session, {
      name: "Intervalo",
      totalTime: 20 * MIN,
    });
    store.updateTimer(session, intervalo.id, {
      accrual: { sourceTimerId: aula.id, everyMs: HOUR, addMs: 5 * MIN },
    });

    aula.status = "running";
    aula.startTime = Date.now() - 3 * HOUR;
    store.applyAccruals(session);
    assert.equal(intervalo.bonusMs, 15 * MIN);

    store.updateTimer(session, intervalo.id, { offsetMs: 5 * MIN });

    assert.equal(intervalo.bonusMs, 15 * MIN, "o bonus tem que sobreviver");
    assert.equal(intervalo.elapsed, 5 * MIN);
    assert.equal(store.getRemaining(intervalo), 30 * MIN);
  });

  it("Reset continua descartando o bonus, ao contrario do consumo", () => {
    const { store } = createStore();
    const session = store.createSession();
    const aula = session.timers[0];
    const intervalo = store.addTimer(session, { totalTime: 20 * MIN });
    store.updateTimer(session, intervalo.id, {
      accrual: { sourceTimerId: aula.id, everyMs: MIN, addMs: 5 * MIN },
    });

    aula.status = "running";
    aula.startTime = Date.now() - 2 * MIN;
    store.applyAccruals(session);
    assert.ok(intervalo.bonusMs > 0);

    store.resetSessionTimer(session, intervalo.id);
    assert.equal(intervalo.bonusMs, 0);
  });

  it("exporta e reimporta a sessao inteira", () => {
    const { store } = createStore();
    const session = store.createSession();
    const aula = session.timers[0];
    store.updateTimer(session, aula.id, {
      name: "Aula",
      totalTime: 80 * HOUR,
      direction: "down",
    });
    const intervalo = store.addTimer(session, {
      name: "Intervalo",
      totalTime: 20 * MIN,
    });
    store.updateTimer(session, intervalo.id, {
      offsetMs: 3 * MIN,
      accrual: { sourceTimerId: aula.id, everyMs: HOUR, addMs: 5 * MIN },
    });
    store.startSessionTimer(session, aula.id);

    const snapshot = JSON.parse(JSON.stringify(store.exportSessions()));
    stopSession(store, session);

    // Um processo novo, comecando do zero.
    const { store: outro } = createStore();
    assert.equal(outro.importSessions(snapshot), 1);

    const restaurada = outro.getSession(session.id);
    assert.ok(restaurada, "a sessao precisa voltar");
    assert.equal(restaurada.adminToken, session.adminToken, "o link do admin segue valendo");
    assert.equal(restaurada.timers.length, 2);
    assert.equal(restaurada.primaryTimerId, session.primaryTimerId);

    const aula2 = restaurada.timers[0];
    const int2 = restaurada.timers[1];
    assert.equal(aula2.name, "Aula");
    assert.equal(aula2.totalTime, 80 * HOUR);
    assert.equal(aula2.status, "running", "quem estava rodando volta rodando");
    assert.equal(int2.offsetMs, 3 * MIN);
    assert.equal(int2.accrual.sourceTimerId, aula.id);
    assert.equal(int2.accrual.addMs, 5 * MIN);
    assert.ok(restaurada.interval, "o tick precisa religar sozinho");

    stopSession(outro, restaurada);
  });

  it("ignora snapshot corrompido em vez de derrubar o processo", () => {
    const { store } = createStore();
    assert.equal(store.importSessions(null), 0);
    assert.equal(store.importSessions([{ id: "nao-e-id" }]), 0);
    assert.equal(store.importSessions([{ id: "aaaaaaaa", adminToken: "x" }]), 0);
  });
});

describe("duracao longa", () => {
  const HOUR = 60 * 60 * 1000;

  it("mantem a precisao de uma contagem de 80 horas", () => {
    const { store } = createStore();
    const session = store.createSession();
    const timer = store.addTimer(session, {
      name: "Aula",
      totalTime: 80 * HOUR,
    });

    // Simula 79 horas ja decorridas: a conta usa Date.now(), nao a soma dos
    // ticks, entao atraso ou perda de tick nao desalinha o cronometro.
    timer.status = "running";
    timer.startTime = Date.now() - 79 * HOUR;

    const remaining = store.getRemaining(timer);
    assert.ok(
      Math.abs(remaining - HOUR) < 50,
      `esperava ~1h restante, veio ${remaining}ms`,
    );
    assert.equal(Number.isSafeInteger(timer.totalTime), true);
  });

  it("um cronometro rodando renova o TTL sozinho, sem cliente conectado", () => {
    const { store } = createStore();
    const session = store.createSession();
    store.startSessionTimer(session, session.timers[0].id);

    // Sem o tick, este lastAccessAt ja teria expirado a sessao.
    session.lastAccessAt = Date.now() - (SESSION_TTL_MS + 1000);
    store.broadcastSession(session.id);

    assert.equal(store.getSession(session.id), session);
    assert.ok(Date.now() - session.lastAccessAt < 1000);

    stopSession(store, session);
  });

  it("nao acumula intervalos ao longo de varios start/pause", () => {
    const { store } = createStore();
    const session = store.createSession();
    const timerId = session.timers[0].id;
    const criados = [];

    for (let i = 0; i < 50; i += 1) {
      store.startSessionTimer(session, timerId);
      criados.push(session.interval);
      store.pauseSessionTimer(session, timerId);
      assert.equal(session.interval, null, `sobrou intervalo na volta ${i}`);
    }

    assert.equal(new Set(criados).size, 50, "cada start deve criar um unico tick");
  });

  it("um cronometro que termina nao derruba o tick dos que continuam", () => {
    const { store } = createStore();
    const session = store.createSession();
    const curto = session.timers[0];
    const longo = store.addTimer(session, { totalTime: 80 * HOUR });

    store.startSessionTimer(session, longo.id);
    curto.status = "running";
    curto.startTime = Date.now() - 10 * HOUR;

    store.broadcastSession(session.id);

    assert.equal(curto.status, "finished");
    assert.equal(longo.status, "running");
    assert.ok(session.interval, "o tick precisa seguir vivo");

    stopSession(store, session);
  });

  it("aguenta o relogio do sistema andar para tras sem quebrar o estado", () => {
    const { store } = createStore();
    const session = store.createSession();
    const timer = session.timers[0];

    // Uma correcao de NTP para tras deixa startTime no futuro.
    timer.status = "running";
    timer.startTime = Date.now() + 5000;

    const state = store.buildSessionState(session).timers[0];
    assert.equal(Number.isFinite(state.remaining), true);
    assert.equal(Number.isFinite(state.elapsed), true);
    assert.ok(state.pct >= 0 && state.pct <= 1, `pct fora da faixa: ${state.pct}`);
    assert.equal(store.getRemaining(timer), timer.totalTime);
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
