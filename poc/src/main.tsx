import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import App from './App';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container not found');
}

createRoot(container).render(<App />);
