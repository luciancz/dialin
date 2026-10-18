import { route } from '../app/router';
import { Home } from './screens/Home';
import { Probe } from './screens/Probe';

const tabs: [string, string][] = [
  ['/', 'Home'],
  ['/probe', 'Probe'],
];

export function App() {
  const path = route.value.path;
  let screen = <Home />;
  if (path === '/probe') screen = <Probe />;
  return (
    <>
      {screen}
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
