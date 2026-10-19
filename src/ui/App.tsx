import { exitDemo } from '../app/demo';
import { isDemo } from '../app/mode';
import { match, route } from '../app/router';
import { app } from '../app/state';
import { Toasts } from './components/Toasts';
import { BagDetail } from './screens/BagDetail';
import { Beans } from './screens/Beans';
import { Demo } from './screens/Demo';
import { Hardware } from './screens/Hardware';
import { History } from './screens/History';
import { Home } from './screens/Home';
import { Onboarding } from './screens/Onboarding';
import { Probe } from './screens/Probe';
import { RpmCalibration } from './screens/RpmCalibration';
import { Settings } from './screens/Settings';
import { Shot } from './screens/Shot';

const tabs: [string, string][] = [
  ['/', 'Home'],
  ['/shot', 'Shot'],
  ['/beans', 'Beans'],
  ['/history', 'History'],
  ['/settings', 'Settings'],
];

export function App() {
  const path = route.value.path;
  let screen: preact.JSX.Element;
  const bagMatch = match(path, '/bag/:id');
  if (!app.ready.value && path !== '/probe') {
    screen = (
      <div>
        <h1>Dial-in</h1>
        <p class="muted">Opening the local database…</p>
      </div>
    );
  } else if (path === '/probe') screen = <Probe />;
  else if (path === '/demo') screen = <Demo />;
  else if (path === '/shot') screen = <Shot />;
  else if (path === '/beans') screen = <Beans />;
  else if (bagMatch) screen = <BagDetail id={bagMatch.id ?? ''} />;
  else if (path === '/history') screen = <History />;
  else if (path === '/hardware') screen = <Hardware />;
  else if (path === '/rpm') screen = <RpmCalibration />;
  else if (path === '/onboarding') screen = <Onboarding />;
  else if (path === '/settings') screen = <Settings />;
  else screen = <Home />;
  return (
    <>
      {isDemo() ? (
        <div class="demo-banner">
          <a href="#/demo" class="demo-link">
            Simulation: simulated grinder, scale and taste, separate data
          </a>
          <button type="button" class="small" onClick={exitDemo}>
            Leave
          </button>
        </div>
      ) : null}
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
