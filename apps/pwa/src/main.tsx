import { render } from 'preact';
import { App } from './App.tsx';
import { registerServiceWorker } from './sw-client.ts';
import './style.css';

registerServiceWorker();
const root = document.getElementById('app');
if (root) render(<App />, root);
