import "./helpers/offline-env.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import zlib from "node:zlib";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { seedDatabase } from "../src/seed/seed.js";
import { LessonInstance } from "../src/models/index.js";
import { addDays } from "../src/utils/dates.js";

/**
 * Illustration de la fiche d'une séance : brouillon créé par l'IA (qui lit la leçon), retouche à partir du
 * brouillon (image jointe), validation qui ne change QUE l'image de la fiche. L'IA est un faux serveur local.
 */
let mongo: MongoMemoryServer;
let server: Server;
let fake: Server;
let base = "";
let token = "";
const prompts: { text: string; images: number }[] = [];
const today = new Date().toISOString().slice(0, 10);

/** PNG 2×1 valide (pour que la taille de l'image soit lue). */
function png() {
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 255, 255, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

before(async () => {
  const image = `data:image/png;base64,${png().toString("base64")}`;
  fake = http
    .createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const content = body.messages[0].content;
        prompts.push(typeof content === "string" ? { text: content, images: 0 } : { text: content[0].text, images: content.length - 1 });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "", images: [{ image_url: { url: image } }] } }], usage: { cost: 0.01, prompt_tokens: 10, completion_tokens: 10 } }));
      });
    })
    .listen(0);
  Object.assign(env, { openrouterApiKey: "test-local", openrouterBaseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` });

  mongo = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || "8.2.6" } });
  await mongoose.connect(mongo.getUri("pedago-illustration-test"));
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

test("illustration : brouillon, retouche, validation ; seule l'image de la fiche change", async () => {
  const plan = await call(`/teacher/planning?from=${today}&to=${addDays(today, 10)}`);
  const lesson = plan.body.lessons.find((l: any) => l.status === "planned" && l.date > today);
  assert.ok(lesson, "une séance à venir");
  const before = await call(`/teacher/lessons/${lesson.id}/file`, { method: "POST" });

  // 1. Brouillon : l'IA lit la leçon ; rien n'entre encore dans la fiche.
  const first = await call(`/teacher/lessons/${lesson.id}/illustration`, { method: "POST", body: { kind: "schema", level: "standard", color: true, legends: true, description: "Des bâtonnets de dizaines et des cubes d'unités." } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.drafts.length, 1);
  assert.equal(first.body.current, null);
  assert.ok(prompts[0].text.includes(lesson.node.title), "le titre de la leçon est dans la demande");
  assert.ok(/légendes/.test(prompts[0].text), "légendes demandées");
  const still = await call(`/teacher/lessons/${lesson.id}/file`, { method: "POST" });
  assert.equal(still.body.version, before.body.version, "la fiche ne change pas avant validation");

  // 2. Retouche du brouillon : l'image du brouillon est jointe ; un 2e brouillon s'ajoute.
  const draftId = first.body.drafts[0].id;
  const second = await call(`/teacher/lessons/${lesson.id}/illustration`, { method: "POST", body: { kind: "schema", level: "standard", color: true, legends: false, description: "Même image, avec une flèche entre dizaine et unités.", fromDraftId: draftId } });
  assert.equal(second.status, 200);
  assert.equal(second.body.drafts.length, 2);
  assert.equal(prompts[1].images, 1, "le brouillon retouché est envoyé à l'IA");
  assert.ok(/aucun texte/i.test(prompts[1].text));

  // 3. Écarter puis valider : la fiche change de version, l'image est en place, les brouillons disparaissent.
  const kept = second.body.drafts[0].id;
  const left = await call(`/teacher/lessons/${lesson.id}/illustration/${draftId}`, { method: "DELETE" });
  assert.equal(left.body.drafts.length, 1);
  const done = await call(`/teacher/lessons/${lesson.id}/illustration/${kept}/accept`, { method: "POST" });
  assert.equal(done.status, 200);
  assert.notEqual(done.body.version, before.body.version);
  assert.ok(done.body.options.illustration?.url);
  const after = await call(`/teacher/lessons/${lesson.id}/illustration`);
  assert.equal(after.body.drafts.length, 0);
  assert.ok(after.body.current?.url);
  const row = await LessonInstance.findById(lesson.id).lean();
  assert.equal(row?.docOptions?.difficulty ?? before.body.options.difficulty, before.body.options.difficulty, "le reste de la fiche est inchangé");
});

test("illustration : brouillon d'une autre séance ou inconnu refusé", async () => {
  const plan = await call(`/teacher/planning?from=${today}&to=${addDays(today, 10)}`);
  const lesson = plan.body.lessons.find((l: any) => l.status === "planned" && l.date > today);
  const r = await call(`/teacher/lessons/${lesson.id}/illustration/abcdefabcdef/accept`, { method: "POST" });
  assert.equal(r.status, 404);
});
