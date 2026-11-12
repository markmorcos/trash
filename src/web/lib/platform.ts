// Which device and browser this is, and how to install the app there.
// Pure functions (no DOM), so they can be unit tested with real user-agent strings.

export type Platform =
  | "ios" // Safari on iPhone / iPad
  | "ios-other" // Chrome, Firefox, Edge on iPhone / iPad (iOS 16.4+)
  | "android-chrome" // Chrome, Edge and other Chromium browsers on Android
  | "android-samsung"
  | "android-firefox"
  | "desktop-chromium" // Chrome, Edge, Brave… on Windows, macOS, Linux, ChromeOS
  | "desktop-safari"
  | "desktop-firefox"
  | "in-app" // Instagram, Facebook, LinkedIn… built-in browsers
  | "other";

export interface DeviceInfo {
  userAgent: string;
  /** navigator.maxTouchPoints: iPadOS reports a Mac user agent but has touch. */
  maxTouchPoints?: number;
}

export function detectPlatform({ userAgent: ua, maxTouchPoints = 0 }: DeviceInfo): Platform {
  if (/Instagram|FBAN|FBAV|FB_IAB|LinkedInApp|Line\/|Snapchat|TikTok|musical_ly/i.test(ua)) return "in-app";
  const iPadAsMac = /Macintosh/.test(ua) && maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPadAsMac) return /CriOS|FxiOS|EdgiOS/.test(ua) ? "ios-other" : "ios";
  if (/Android/.test(ua)) {
    if (/SamsungBrowser/.test(ua)) return "android-samsung";
    if (/Firefox\//.test(ua)) return "android-firefox";
    return "android-chrome";
  }
  if (/Firefox\//.test(ua)) return "desktop-firefox";
  if (/Edg\/|Chrome\/|Chromium\/|CrOS/.test(ua)) return "desktop-chromium";
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && /Version\//.test(ua)) return "desktop-safari";
  return "other";
}

export interface InstallGuide {
  title: string;
  /** Ordered steps; omitted when a single Install button does the job. */
  steps: string[];
  /** True when the page can show the browser's own install prompt. */
  button: boolean;
  note?: string;
}

/**
 * What to tell this device. `canPrompt` is true once the browser has offered its
 * install prompt (Chrome/Edge `beforeinstallprompt`), so one button is enough.
 */
export function installGuide(platform: Platform, canPrompt = false): InstallGuide {
  if (canPrompt && (platform === "android-chrome" || platform === "android-samsung" || platform === "desktop-chromium" || platform === "other")) {
    return { title: "Install the app", steps: [], button: true, note: "It opens like an app, works offline, and can send the Sunday reminder." };
  }
  switch (platform) {
    case "ios":
      return {
        title: "Add to your Home Screen",
        steps: [
          "Tap the Share button (the square with an arrow) in Safari's toolbar.",
          "Scroll down and tap Add to Home Screen.",
          "Tap Add, then open Trash from your Home Screen.",
        ],
        button: false,
        note: "On iPhone, reminders only work from the Home Screen app.",
      };
    case "ios-other":
      return {
        title: "Add to your Home Screen",
        steps: [
          "Tap the Share button in the address bar.",
          "Tap Add to Home Screen. If you don't see it, open this page in Safari instead.",
          "Tap Add, then open Trash from your Home Screen.",
        ],
        button: false,
        note: "On iPhone, reminders only work from the Home Screen app.",
      };
    case "android-chrome":
      return {
        title: "Install the app",
        steps: ["Tap the ⋮ menu at the top right.", "Tap Add to Home screen, then Install."],
        button: false,
      };
    case "android-samsung":
      return {
        title: "Install the app",
        steps: ["Tap the ≡ menu at the bottom right.", "Tap Add page to, then Home screen."],
        button: false,
      };
    case "android-firefox":
      return {
        title: "Install the app",
        steps: ["Tap the ⋮ menu.", "Tap Add app to Home screen (or Install)."],
        button: false,
      };
    case "desktop-chromium":
      return {
        title: "Install the app",
        steps: [
          "Click the install icon at the right end of the address bar.",
          "Or open the browser menu and choose Install Trash (Edge: Apps, then Install this site as an app).",
        ],
        button: false,
      };
    case "desktop-safari":
      return {
        title: "Add to your Dock",
        steps: ["In the menu bar, choose File, then Add to Dock.", "Click Add. Trash opens from the Dock like an app."],
        button: false,
        note: "Needs macOS Sonoma (14) or later.",
      };
    case "desktop-firefox":
      return {
        title: "Keep it handy",
        steps: ["Firefox on a computer can't install web apps. Right-click this tab and choose Pin Tab, or open the page in Chrome, Edge or Safari to install it."],
        button: false,
      };
    case "in-app":
      return {
        title: "Open in your browser first",
        steps: [
          "This page is open inside another app, which can't install it.",
          "Tap ⋯ or the share icon and choose Open in browser (or Open in Safari / Chrome).",
          "Then follow the install steps there.",
        ],
        button: false,
      };
    default:
      return {
        title: "Install the app",
        steps: ["Look for Install or Add to Home Screen in your browser's menu."],
        button: false,
      };
  }
}
