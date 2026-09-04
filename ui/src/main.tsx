import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('UI_ROOT_MISSING');

createRoot(root).render(
	<StrictMode>
		<BrowserRouter basename={import.meta.env.BASE_URL}>
			<App />
		</BrowserRouter>
	</StrictMode>,
);
