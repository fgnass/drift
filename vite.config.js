import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { letteringPlugin } from "./scripts/lettering.mjs";

const description =
  "A blizzard outside your window, synthesized live. Made to help you relax and drift off to sleep.";

export default defineConfig({
  plugins: [
    letteringPlugin(),
    VitePWA({
      // Updates apply on the next launch, so a reload never stops the sound.
      registerType: "prompt",
      includeAssets: ["favicon.svg", "favicon.ico", "icons/apple-touch-icon.png"],
      manifest: {
        name: "drift",
        short_name: "drift",
        description,
        lang: "en",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#080b12",
        theme_color: "#080b12",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          { src: "icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        // Screenshots are only for link previews and the portfolio page.
        globIgnores: ["screenshots/**", "icons/icon-1024.png"],
      },
    }),
  ],
});
