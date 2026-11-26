import "./helpers/offline-env.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { seedDatabase } from "../src/seed/seed.js";
import { LessonInstance, Notification, PushToken } from "../src/models/index.js";
import { localNow, runReminders } from "../src/services/notifications.js";
import { addDays } from "../src/utils/dates.js";

/** Notifications push : téléphone enregistré, rappel 10 min avant le cours (une seule fois), cloche, jeton périmé oublié. */
let mongo: MongoMemoryServer;
let server: Server;
let fake: Server;
let base = "";
let token = "";
const sent: any[] = [];
let refuse = false;

async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

before(async () => {
  fake = http
    .createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const msgs = JSON.parse(raw);
        sent.push(...msgs);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: msgs.map(() => (refuse ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "x" })) }));
      });
    })
    .listen(0);
  Object.assign(env, { expoPushUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/push` });
  mongo = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || "8.2.6" } });
  await mongoose.connect(mongo.getUri("pedago-push-test"));
  await seedDatabase();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await call("/auth/login", { method: "POST", body: { identifier: "enseignant@pedago.test", password: "Pedago-Enseignant-2026!" } });
  token = login.body.accessToken;
});

after(async () => {
  server.close();
  fake.close();
  await mongoose.disconnect();
  await mongo.stop();
});

test("push : rappel 10 min avant le cours, une seule fois, visible dans la cloche ; jeton périmé oublié", async () => {
  const today = localNow().date;
  const plan = await call(`/teacher/planning?from=${today}&to=${addDays(today, 14)}`);
  const lesson = plan.body.lessons.find((l: any) => l.status === "planned" && l.start);
  assert.ok(lesson, "une séance prévue");
  assert.equal((await call("/teacher/me/push-token", { method: "POST", body: { token: "ExponentPushToken[test-123]", platform: "android" } })).status, 204);
  assert.equal((await call("/teacher/me/push-token", { method: "POST", body: { token: "pas-un-jeton", platform: "android" } })).status, 400);

  // « Maintenant » = 5 min avant le début de la séance, à l'heure du Cameroun (UTC+1).
  const [h, m] = lesson.start.split(":").map(Number);
  const now = new Date(`${lesson.date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+01:00`);
  now.setMinutes(now.getMinutes() - 5);
  await LessonInstance.updateMany({ date: lesson.date, _id: { $ne: lesson.id }, start: { $lte: lesson.start } }, { status: "cancelled" });
  await runReminders(now);
  await runReminders(now);
  const pushes = sent.filter((s) => s.data.href.includes(lesson.id));
  assert.equal(pushes.length, 1, "un seul envoi pour ce cours");
  assert.equal(pushes[0].to, "ExponentPushToken[test-123]");
  assert.match(pushes[0].title, /^Dans 5 min/);
  assert.equal(pushes[0].data.href, `/generer?lessonId=${lesson.id}&date=${lesson.date}`);

  const list = await call("/teacher/notifications");
  assert.ok(list.body.some((n: any) => n.key === `lesson:${lesson.id}` && !n.read));
  await call("/teacher/notifications/read", { method: "POST" });
  assert.ok((await call("/teacher/notifications")).body.every((n: any) => n.read));

  // Application désinstallée : Expo refuse le jeton, il est oublié.
  refuse = true;
  await Notification.deleteMany({});
  await runReminders(now);
  assert.equal(await PushToken.countDocuments(), 0);
});

test("push : préférence coupée = pas d'envoi, la notification reste dans la cloche", async () => {
  await call("/teacher/me/push-token", { method: "POST", body: { token: "ExponentPushToken[test-456]", platform: "ios" } });
  const me = await call("/teacher/me");
  await call("/teacher/me/profile", { method: "PUT", body: { ...me.body.profile, preferences: { ...me.body.profile.preferences, pushReminders: false } } });
  const before = sent.length;
  const { notify } = await import("../src/services/notifications.js");
  await notify(me.body.id, { key: "info:test", kind: "info", title: "Test", body: "Corps" });
  assert.equal(sent.length, before);
  assert.ok((await call("/teacher/notifications")).body.some((n: any) => n.key === "info:test"));
});
