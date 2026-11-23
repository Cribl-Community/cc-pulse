import { defineConfig, type IndexHtmlTransformContext, type IndexHtmlTransformResult, type ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'path'
import react from '@vitejs/plugin-react'
// @ts-ignore
import { servePackageTgz } from '@cribl/apps/package'
// @ts-ignore
import { backendPreviewPlugin, backendWatchPlugin } from '@cribl/apps/preview'

// @ts-ignore
import { criblLive } from './dev/cribl-live.mjs'
// @ts-ignore
import { criblPreview } from './dev/cribl-preview.mjs'

const packageEndpointPlugin = () => ({
  name: 'vite-plugin-package-endpoint',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/package.tgz', (req: IncomingMessage, res: ServerResponse) => {
      void servePackageTgz(req, res, server.config.root)
    })
  },
})

const WATCHED_CONFIG_FILES = ['package.json', 'config/proxies.yml', 'config/policies.yml', 'config/schedules.yml', 'config/backend.yml'];
const CONFIG_CHANGED_HMR_EVENT = 'cribl:config-changed';

const CONFIG_CHANGED_BRIDGE = `
import { createHotContext } from '/@vite/client';
const hot = createHotContext('cribl:config-watcher');
hot.on('${CONFIG_CHANGED_HMR_EVENT}', (data) => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'CRIBL_APP_CONFIG_CHANGED', file: data && data.file }, '*');
  }
  window.location.reload();
});
`;

const injectScriptFromQueryPlugin = () => {
  let initScriptUrl: string | null = null;
  return {
    name: 'inject-script-from-query',
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      const watched = WATCHED_CONFIG_FILES.map((rel) => join(root, rel));
      server.watcher.add(watched);
      server.watcher.on('change', (file) => {
        const idx = watched.indexOf(file);
        if (idx === -1) return;
        server.ws.send(CONFIG_CHANGED_HMR_EVENT, { file: WATCHED_CONFIG_FILES[idx] });
      });
    },
    transformIndexHtml(html: string, ctx: IndexHtmlTransformContext): IndexHtmlTransformResult{
      const url = new URL(ctx.originalUrl ?? '/', 'https://localhost');
      initScriptUrl = url.searchParams.get('init');
      const root = process.cwd();
      let appName;
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: string };
        appName = pkg.name;
      } catch {
        /* ignore missing or invalid package.json */
      }
      appName = appName || 'unknown';
      const tags: Array<{ tag: string; attrs?: Record<string, string>; children?: string; injectTo: 'head-prepend' }> = [];
      tags.push({
        tag: 'script',
        children: `window.CRIBL_APP_ID = '__dev__${appName}';`,
        injectTo: 'head-prepend' as const,
      });
      if (ctx.server) {
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          children: CONFIG_CHANGED_BRIDGE,
          injectTo: 'head-prepend' as const,
        });
      }
      if (initScriptUrl) {
        tags.push({
          tag: 'script',
          attrs: { src: initScriptUrl, type: 'text/javascript' },
          injectTo: 'head-prepend' as const,
        });
      }
      return { html, tags };
    },
  };
};

// Production hostMode() is never 'demo' (that return exists only when import.meta.env.DEV).
// state.tsx and series.ts still dynamic-import the demo module, which would ship ~9 KB never loaded
// in a production build. Dev server does not use this plugin, so `npm run dev` keeps the real module.
const dropDeadDemo = () => ({
  name: 'drop-dead-demo',
  apply: 'build' as const,
  transform(code: string) {
    if (!code.includes('demo')) return null;
    const next = code
      .replaceAll('import("./lib/demo")', 'Promise.resolve({})')
      .replaceAll("import('./lib/demo')", 'Promise.resolve({})')
      .replaceAll('import("../lib/demo")', 'Promise.resolve({})')
      .replaceAll("import('../lib/demo')", 'Promise.resolve({})')
      .replaceAll('import("./demo")', 'Promise.resolve({})')
      .replaceAll("import('./demo')", 'Promise.resolve({})');
    return next === code ? null : next;
  },
});

// EmptyState's default (and the only illustration this app passes) is EmptyFolder.
// The other light/dark SVGs are still dynamic imports in @capra/core, so they ship as
// chunks nothing can request. Drop them in production; dev keeps the full set.
const dropUnusedIllustrations = () => ({
  name: 'drop-unused-illustrations',
  apply: 'build' as const,
  transform(code: string, id: string) {
    if (!id.includes('/@capra/core/') || !code.includes('const ILLUSTRATIONS')) return null;
    const next = code.replace(/^[ \t]+(?!EmptyFolder\b)[A-Z][A-Za-z]+: \{[ \t]*\r?\n[ \t]*light: lazyLoad\(\(\) => import\("@capra\/icons\/esm\/images\/[^"]+"\)\),[ \t]*\r?\n[ \t]*dark: lazyLoad\(\(\) => import\("@capra\/icons\/esm\/images\/[^"]+"\)\)[ \t]*\r?\n[ \t]*\},?[ \t]*\r?\n/gm, '');
    return next === code ? null : next;
  },
});

export default defineConfig({
  plugins: [react(), packageEndpointPlugin(), criblPreview(), injectScriptFromQueryPlugin(), backendWatchPlugin(), backendPreviewPlugin(), criblLive(), dropDeadDemo(), dropUnusedIllustrations()],
  base: './',
  server: {
    cors: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
})
