import { route } from '../app/router';
import { app } from '../app/state';
import { Toasts } from './components/Toasts';
import { Beans } from './screens/Beans';
import { Home } from './screens/Home';
import { Probe } from './screens/Probe';
import { Settings } from './screens/Settings';
import { Shot } from './screens/Shot';

const tabs: [string, string][] = [
  ['/', 'Home'],
  ['/shot', 'Shot'],
  ['/beans', 'Beans'],
  ['/settings', 'Settings'],
];

export function App() {
  const path = route.value.path;
  let screen: preact.JSX.Element;
  if (!app.ready.value && path !== '/probe') {
    screen = (
      <div>
        <h1>Dial-in</h1>
        <p class="muted">Opening the local database…</p>
      </div>
    );
  } else if (path === '/probe') screen = <Probe />;
  else if (path === '/shot') screen = <Shot />;
  else if (path === '/beans') screen = <Beans />;
  else if (path === '/settings') screen = <Settings />;
  else screen = <Home />;
  return (
    <>
      {screen}
      <Toasts />
      <nav class="tabs">
        {tabs.map(([href, label]) => (
          <a key={href} href={`#${href}`} class={path === href ? 'active' : ''}>
            {label}
          </a>
        ))}
      </nav>
    </>
  );
}
