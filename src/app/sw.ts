/**
 * Service-worker state for the UI: registered?, update waiting?, and the user-tap
 * activation of a new version (never automatic; suppressed while a shot is armed or running).
 */
import { signal } from '@preact/signals';

class SwState {
  readonly registered = signal<boolean | null>(null);
  readonly error = signal<string>('');
  readonly updateWaiting = signal<boolean>(false);
  private registration: ServiceWorkerRegistration | null = null;

  watch(reg: ServiceWorkerRegistration): void {
    this.registration = reg;
    if (reg.waiting) this.updateWaiting.value = true;
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          this.updateWaiting.value = true;
        }
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      location.reload();
    });
  }

  /** Activate the waiting worker (user tap only). */
  applyUpdate(): void {
    this.registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
  }
}

export const swState = new SwState();
