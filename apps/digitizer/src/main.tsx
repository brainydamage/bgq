import { render } from 'preact';
import { App } from './App.tsx';
import { RiddlesPage } from './RiddlesPage.tsx';
import './style.css';

const root = document.getElementById('app');
// /riddles — страница «Загадки» (для второго ноутбука по ссылке ./bgq map --lan).
if (root) render(location.pathname.startsWith('/riddles') ? <RiddlesPage /> : <App />, root);
