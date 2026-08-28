/**
 * Browser entry point. Kept separate from `main.ts` so importing the application
 * does not boot one as a side effect — which is what lets the whole thing be
 * driven from a test.
 */

import { startApp } from './main';

const mount = document.getElementById('app');
if (!mount) throw new Error('Laneweaver needs an element with id "app" to mount into.');
const app = startApp(mount);

// A handle on the live app, dev builds only. Poking at the compiled network from
// the console is how most rendering questions get answered.
if (import.meta.env.DEV) (globalThis as Record<string, unknown>).laneweaver = app;
