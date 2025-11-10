import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = path.resolve("screenshots");

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();

const sampleBundle = {
  bundle_id: "mock-bundle-sample",
  tasks: [
    {
      task_id: "mock-task-sample-1",
      assignment_id: "mock-assign-sample-1",
      lease_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      clip: {
        id: "mock-clip-1",
        asset_id: "mock-asset-1",
        start_ms: 0,
        end_ms: 12000,
        overlap_ms: 2000,
        speakers: ["A"],
        audio_url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
        video_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        captions_vtt_url: "https://gist.githubusercontent.com/raw/cc0-example/flower-en.vtt",
        captions_auto_enabled: true,
        context_prev_clip: null,
        context_next_clip: null,
      },
      task_type: "translation_check",
      ai_suggestion: { translation: "Hello! Thanks for taking the survey today." },
      price_cents: 8,
    },
    {
      task_id: "mock-task-sample-2",
      assignment_id: "mock-assign-sample-2",
      lease_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      clip: {
        id: "mock-clip-2",
        asset_id: "mock-asset-2",
        start_ms: 0,
        end_ms: 12000,
        overlap_ms: 2000,
        speakers: ["A"],
        audio_url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3",
        video_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm",
        captions_vtt_url: "https://gist.githubusercontent.com/raw/cc0-example/flower-ar.vtt",
        captions_auto_enabled: true,
        context_prev_clip: null,
        context_next_clip: null,
      },
      task_type: "emotion_tag",
      ai_suggestion: { emotion_primary: "Happy", confidence: 0.74 },
      price_cents: 7,
    },
  ],
};

async function newContext({
  colorScheme = "light",
  locale = "en",
  seedCachedBundle = false,
} = {}) {
  const context = await browser.newContext({
    colorScheme,
    viewport: { width: 1400, height: 900 },
  });
  await context.addInitScript(
    ({ locale }) => {
      window.localStorage.setItem("dd-mobile-locale", locale);
    },
    { locale }
  );
  if (seedCachedBundle) {
    await context.addInitScript((bundle) => {
      const request = indexedDB.open("dd-mobile", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("bundles")) {
          db.createObjectStore("bundles");
        }
        if (!db.objectStoreNames.contains("pendingSubmissions")) {
          db.createObjectStore("pendingSubmissions", {
            keyPath: "idempotencyKey",
          });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("bundles", "readwrite");
        tx.objectStore("bundles").put(bundle, bundle.bundle_id);
        tx.oncomplete = () => db.close();
      };
    }, sampleBundle);
  }
  return context;
}

async function seedPendingSubmissions(page) {
  const now = Date.now();
  const entries = [
    {
      task_id: "mock-task-queue-1",
      assignment_id: "mock-assign-1",
      payload: { approved: true },
      duration_ms: 12000,
      playback_ratio: 0.91,
      created_at: now - 60_000,
      endpoint: "/api/mobile/tasks/submit",
      idempotencyKey: "queue-1",
    },
    {
      task_id: "mock-task-queue-2",
      assignment_id: "mock-assign-2",
      payload: { speaker: "A", region: "Gulf" },
      duration_ms: 12000,
      playback_ratio: 0.88,
      created_at: now - 30_000,
      endpoint: "/api/mobile/tasks/submit",
      idempotencyKey: "queue-2",
    },
  ];
  await page.evaluate(async (entries) => {
    function openDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("dd-mobile", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("bundles")) {
            db.createObjectStore("bundles");
          }
          if (!db.objectStoreNames.contains("pendingSubmissions")) {
            db.createObjectStore("pendingSubmissions", {
              keyPath: "idempotencyKey",
            });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("pendingSubmissions", "readwrite");
      const store = tx.objectStore("pendingSubmissions");
      entries.forEach((entry) => store.put(entry));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, entries);
}

async function capture(pathName, page) {
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(OUT_DIR, pathName),
    fullPage: true,
  });
}

async function captureMobileLight() {
  const context = await newContext({
    colorScheme: "light",
    locale: "en",
    seedCachedBundle: true,
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/mobile`, { waitUntil: "networkidle" });
  await capture("mobile-light.png", page);
  await context.close();
}

async function captureMobileDark() {
  const context = await newContext({
    colorScheme: "dark",
    locale: "en",
    seedCachedBundle: true,
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/mobile`, { waitUntil: "networkidle" });
  await capture("mobile-dark.png", page);
  await context.close();
}

async function captureMobileRtl() {
  const context = await newContext({
    colorScheme: "light",
    locale: "ar",
    seedCachedBundle: true,
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/mobile`, { waitUntil: "networkidle" });
  await capture("mobile-rtl.png", page);
  await context.close();
}

async function captureOfflineQueue() {
  const context = await newContext({
    colorScheme: "light",
    locale: "en",
    seedCachedBundle: true,
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/mobile`, { waitUntil: "networkidle" });
  await seedPendingSubmissions(page);
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /tasks cached/i })
    .click();
  await capture("mobile-offline-queue.png", page);
  await context.close();
}

async function captureTaskDetail() {
  const context = await newContext({
    colorScheme: "light",
    locale: "en",
    seedCachedBundle: true,
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/mobile`, { waitUntil: "networkidle" });
  await page.waitForSelector('a[href^="/mobile/tasks/"]', {
    timeout: 20000,
    state: "attached",
  });
  const taskLink = page.locator('a[href^="/mobile/tasks/"]').first();
  const linkTexts = await page
    .locator('a[href^="/mobile/tasks/"]')
    .allTextContents();
  console.log("task cards:", linkTexts);
  await taskLink.click();
  await page.waitForURL("**/mobile/tasks/**", { timeout: 15000 });
  const buttons = await page.locator("button").allTextContents();
  console.log("task detail buttons:", buttons);
  const loadContextButton = page.locator("button", {
    hasText: /loadcontext/i,
  });
  await page.waitForTimeout(1000);
  const mainText = await page.locator("main").innerText().catch(() => "");
  console.log("task detail main:", mainText.slice(0, 140));
  await loadContextButton.waitFor({ timeout: 15000 });
  await loadContextButton.click();
  await page.waitForSelector("text=Context details");
  await capture("mobile-task-detail.png", page);
  await context.close();
}

async function captureAdminKpi() {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/admin/mobile/kpi`, {
    waitUntil: "networkidle",
  });
  await capture("admin-kpi.png", page);
  await context.close();
}

async function captureAdminConfusion() {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/admin/mobile/confusion`, {
    waitUntil: "networkidle",
  });
  await capture("admin-confusion.png", page);
  await context.close();
}

const defaultShots = [
  "mobileLight",
  "mobileDark",
  "mobileRtl",
  "offlineQueue",
  "taskDetail",
  "adminKpi",
  "adminConfusion",
];

const shots = (process.env.SHOTS || defaultShots.join(","))
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

for (const shot of shots) {
  switch (shot) {
    case "mobileLight":
      await captureMobileLight();
      break;
    case "mobileDark":
      await captureMobileDark();
      break;
    case "mobileRtl":
      await captureMobileRtl();
      break;
    case "offlineQueue":
      await captureOfflineQueue();
      break;
    case "taskDetail":
      await captureTaskDetail();
      break;
    case "adminKpi":
      await captureAdminKpi();
      break;
    case "adminConfusion":
      await captureAdminConfusion();
      break;
    default:
      console.warn(`Unknown shot "${shot}", skipping.`);
  }
}

await browser.close();
