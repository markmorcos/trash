// The server really serves what browsers need before they offer "Install" or
// "Add to Home Screen": the manifest, its icons, the iOS touch icon and a service
// worker with a fetch handler. Needs `npm run build` first (serves dist/web).
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPod, type Pod } from "../support/server";

const dbUrl = process.env.TEST_DATABASE_URL;

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf: ArrayBuffer): [number, number] {
  const v = new DataView(buf);
  expect(v.getUint32(0)).toBe(0x89504e47); // \x89PNG
  return [v.getUint32(16), v.getUint32(20)];
}

describe.skipIf(!dbUrl)("installable app", () => {
  let pod: Pod;
  beforeAll(async () => {
    if (!existsSync("dist/web/index.html")) throw new Error("run `npm run build` before the integration tests");
    pod = await startPod();
  });
  afterAll(async () => pod?.stop());

  const get = (path: string) => fetch(pod.url + path);

  it("the page links the manifest, the iOS icon and iOS app settings", async () => {
    const html = await (await get("/")).text();
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/icon-180\.png"/);
    expect(html).toMatch(/name="apple-mobile-web-app-capable" content="yes"/);
    expect(html).toMatch(/name="viewport" content="[^"]*viewport-fit=cover/);
  });

  it("serves a manifest browsers accept for installing", async () => {
    const r = await get("/manifest.webmanifest");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/manifest+json");
    const m = await r.json();
    expect(m).toMatchObject({ name: "Trash", short_name: "Trash", display: "standalone", scope: "/" });
    expect(m.start_url).toBe("/#week");
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  });

  it("every manifest icon exists and has the size it claims", async () => {
    const m = await (await get("/manifest.webmanifest")).json();
    for (const icon of m.icons as { src: string; sizes: string; type: string }[]) {
      const r = await get(icon.src);
      expect(r.status, icon.src).toBe(200);
      expect(r.headers.get("content-type"), icon.src).toBe(icon.type);
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(await r.arrayBuffer()), icon.src).toEqual([w, h]);
    }
  });

  it("serves the 180×180 Home Screen icon for iPhone", async () => {
    const r = await get("/icon-180.png");
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(pngSize(await r.arrayBuffer())).toEqual([180, 180]);
  });

  it("serves a fresh service worker that handles fetch and push", async () => {
    const r = await get("/sw.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/javascript/);
    expect(r.headers.get("cache-control")).toBe("no-cache");
    const sw = await r.text();
    expect(sw).toMatch(/addEventListener\("fetch"/);
    expect(sw).toMatch(/addEventListener\("push"/);
  });

  it("the start URL opens the app", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
  });
});
