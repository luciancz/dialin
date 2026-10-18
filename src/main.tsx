import { render } from 'preact';
import './app/recommender';
import { app } from './app/state';
import { swState } from './app/sw';
import { diag } from './diag/log';
import { App } from './ui/App';
import './ui/styles.css';

const root = document.getElementById('app');
if (root) render(<App />, root);
void app.init().catch((err: unknown) => {
  diag.log('error', `database init failed: ${String(err)}`);
});

// Service worker: a Windows-only nicety. WKWebView (Bluefy) has no supported path, so
// registration failure is tolerated and recorded; the app never depends on it.
if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .then((reg) => {
      swState.registered.value = true;
      swState.watch(reg);
      diag.log('info', 'service worker registered');
    })
    .catch((err: unknown) => {
      swState.registered.value = false;
      swState.error.value = String(err);
      diag.log('warn', `service worker registration failed: ${String(err)}`);
    });
} else {
  swState.registered.value = false;
}
