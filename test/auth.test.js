const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  createCredentials,
  sanitizeUsername,
  verifyCredentials,
} = require("../src/auth");

describe("credenciais", () => {
  it("nao guarda a senha em lugar nenhum do objeto", async () => {
    const c = await createCredentials("kerlon", "123");
    assert.ok(!JSON.stringify(c).includes("123"));
    assert.deepEqual(Object.keys(c).sort(), ["hash", "salt", "username"]);
  });

  it("a mesma senha gera hashes diferentes (sal por senha)", async () => {
    const a = await createCredentials("kerlon", "123");
    const b = await createCredentials("kerlon", "123");
    assert.notEqual(a.hash, b.hash);
    assert.notEqual(a.salt, b.salt);
  });

  it("aceita a senha certa e recusa a errada", async () => {
    const c = await createCredentials("kerlon", "123");
    assert.equal(await verifyCredentials(c, "kerlon", "123"), true);
    assert.equal(await verifyCredentials(c, "kerlon", "1234"), false);
    assert.equal(await verifyCredentials(c, "kerlon", ""), false);
  });

  it("usuario e case-insensitive, senha nao", async () => {
    const c = await createCredentials("Kerlon", "AbC");
    assert.equal(await verifyCredentials(c, "kerlon", "AbC"), true);
    assert.equal(await verifyCredentials(c, "KERLON", "AbC"), true);
    assert.equal(await verifyCredentials(c, "kerlon", "abc"), false);
  });

  it("recusa usuario diferente", async () => {
    const c = await createCredentials("kerlon", "123");
    assert.equal(await verifyCredentials(c, "outro", "123"), false);
  });

  it("sessao sem credencial nunca autentica", async () => {
    assert.equal(await verifyCredentials(null, "kerlon", "123"), false);
    assert.equal(await verifyCredentials(undefined, "", ""), false);
  });

  it("recusa entrada invalida em vez de criar credencial fraca", async () => {
    assert.equal(await createCredentials("", "123"), null);
    assert.equal(await createCredentials("kerlon", ""), null);
    assert.equal(await createCredentials("kerlon", null), null);
    assert.equal(await createCredentials(42, "123"), null);
    assert.equal(await createCredentials("kerlon", "x".repeat(201)), null);
  });

  it("sanitizeUsername remove controles e corta no limite", () => {
    assert.equal(sanitizeUsername("  kerlon  "), "kerlon");
    assert.equal(sanitizeUsername("k".repeat(50)).length, 32);
    assert.equal(sanitizeUsername(null), "");
  });

  it("hash corrompido no snapshot nao autentica", async () => {
    const c = await createCredentials("kerlon", "123");
    assert.equal(
      await verifyCredentials({ ...c, hash: "nao-e-hex" }, "kerlon", "123"),
      false,
    );
    assert.equal(
      await verifyCredentials({ ...c, hash: "ab" }, "kerlon", "123"),
      false,
    );
  });
});
