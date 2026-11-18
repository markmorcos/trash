# Patches applied on `npm install` (patch-package)

## `@whiskeysockets/baileys` 7.0.0-rc14

Since about 28 July 2026 WhatsApp changed its linked-device flow, and rc14 (the newest
release) can no longer link: the phone shows "Couldn't link device". The upstream fixes
are not merged or released yet, so these are backported:

- **WhiskeySockets/Baileys#2602**: WhatsApp now sends a `link_code_companion_reg`
  notification without pairing data when "Link with phone number" opens; rc14 crashed on it.
- **WhiskeySockets/Baileys#2765**: handle the new `companion_reg_refresh` notification
  (rotate the adv secret, re-render the pairing QR).
- **#2749 / #2765**: acking a notification before login no longer throws on `creds.me`.

Drop this patch once a Baileys release includes these fixes (patch-package fails the
install if the patch no longer applies, so an upgrade can't silently skip it).
