import { render } from '@solidjs/web';
import './styles.css';
import { App } from './components/App.jsx';

const root = document.getElementById('root');
if (!root) throw new Error('no #root element');
render(() => <App />, root);
