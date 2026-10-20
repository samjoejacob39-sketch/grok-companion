/** Auth tests — scrypt hash/verify, first-run login, session lifecycle. */

import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, hasPassword, tryLogin, logout, sessionData } from "../server/auth.js";
import { replaceConfig, DEFAULTS } from "../server/lib/config.js";

const ENV_PW = process.env.ADMIN_PASSWORD || "unittest-password-1";

test("scrypt password hash verifies and rejects wrong passwords", () => {
  const hash = hashPassword("super-secret-9");
  assert.match(hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(verifyPassword("super-secret-9", hash), true);
  assert.equal(verifyPassword("wrongpassword", hash), false);
});

test("env password seeds first-run login", () => {
  replaceConfig({ ...DEFAULTS, admin: { username: "admin", passwordHash: "" } });
  const r = tryLogin("127.0.0.1", { username: "admin", password: ENV_PW });
  assert.equal(r.ok, true);
  assert.equal(hasPassword(), true);
  const sess = sessionData(r.token);
  assert.ok(sess && sess.username === "admin");
  logout(r.token);
});

test("user password sets first-run login when no env password", () => {
  process.env.ADMIN_PASSWORD = "";
  replaceConfig({ ...DEFAULTS, admin: { username: "admin", passwordHash: "" } });
  const good = tryLogin("127.0.0.1", { username: "admin", password: "first-run-pass-99" });
  assert.equal(good.ok, true);
  logout(good.token);
});

test("short passwords rejected on first run", () => {
  process.env.ADMIN_PASSWORD = "";
  replaceConfig({ ...DEFAULTS, admin: { username: "admin", passwordHash: "" } });
  const r = tryLogin("127.0.0.2", { username: "admin", password: "short" });
  assert.equal(r.ok, false);
  assert.equal(hasPassword(), false);
  process.env.ADMIN_PASSWORD = ENV_PW;
});

test("wrong password rejected (password already set)", () => {
  // ensure a hash exists so this isn't a first-run password seeding test
  replaceConfig({ ...DEFAULTS, admin: { username: "admin", passwordHash: hashPassword("first-run-pass-99") } });
  const r = tryLogin("1.2.3.4", { username: "admin", password: "nope-nope-nope" });
  assert.equal(r.ok, false);
});

test("set password logs in again", () => {
  const r = tryLogin("10.0.0.5", { username: "admin", password: "first-run-pass-99" });
  assert.equal(r.ok, true);
  logout(r.token);
});
