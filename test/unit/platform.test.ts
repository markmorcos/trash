import { describe, expect, it } from "vitest";
import { detectPlatform, installGuide, type Platform } from "../../src/web/lib/platform";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15",
  ipadDesktopMode:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidEdge:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
  winChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  winEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0",
  chromebook:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  instagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]",
  unknown: "SomeBrowser/1.0",
};

describe("detectPlatform", () => {
  const cases: [keyof typeof UA, Platform, number?][] = [
    ["iphoneSafari", "ios"],
    ["iphoneChrome", "ios-other"],
    ["iphoneFirefox", "ios-other"],
    ["ipadDesktopMode", "ios", 5],
    ["androidChrome", "android-chrome"],
    ["androidEdge", "android-chrome"],
    ["samsung", "android-samsung"],
    ["androidFirefox", "android-firefox"],
    ["winChrome", "desktop-chromium"],
    ["winEdge", "desktop-chromium"],
    ["macChrome", "desktop-chromium"],
    ["chromebook", "desktop-chromium"],
    ["macSafari", "desktop-safari", 0],
    ["macFirefox", "desktop-firefox"],
    ["instagram", "in-app"],
    ["facebookAndroid", "in-app"],
    ["unknown", "other"],
  ];
  it.each(cases)("%s → %s", (name, expected, touch) => {
    expect(detectPlatform({ userAgent: UA[name], maxTouchPoints: touch ?? 0 })).toBe(expected);
  });

  it("tells an iPad in desktop mode from a Mac by touch support", () => {
    expect(detectPlatform({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 5 })).toBe("ios");
    expect(detectPlatform({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 0 })).toBe("desktop-safari");
  });
});

describe("installGuide", () => {
  const all: Platform[] = [
    "ios", "ios-other", "android-chrome", "android-samsung", "android-firefox",
    "desktop-chromium", "desktop-safari", "desktop-firefox", "in-app", "other",
  ];

  it("gives every platform a title and at least one step", () => {
    for (const p of all) {
      const g = installGuide(p);
      expect(g.title, p).toBeTruthy();
      expect(g.steps.length, p).toBeGreaterThan(0);
      expect(g.button, p).toBe(false);
    }
  });

  it("iPhone: Share → Add to Home Screen, and says reminders need it", () => {
    const g = installGuide("ios");
    expect(g.steps.join(" ")).toMatch(/Share.*Add to Home Screen/);
    expect(g.note).toMatch(/reminders/);
  });

  it("uses one Install button where the browser offers its prompt", () => {
    for (const p of ["android-chrome", "android-samsung", "desktop-chromium"] as Platform[]) {
      expect(installGuide(p, true)).toMatchObject({ button: true, steps: [] });
    }
  });

  it("never shows a button where no prompt exists, even if asked", () => {
    for (const p of ["ios", "ios-other", "desktop-safari", "desktop-firefox", "in-app", "android-firefox"] as Platform[]) {
      expect(installGuide(p, true).button).toBe(false);
    }
  });

  it("macOS Safari points to File → Add to Dock", () => {
    expect(installGuide("desktop-safari").steps[0]).toMatch(/File, then Add to Dock/);
  });

  it("in-app browsers are told to open a real browser first", () => {
    expect(installGuide("in-app").title).toMatch(/Open in your browser/);
  });
});
