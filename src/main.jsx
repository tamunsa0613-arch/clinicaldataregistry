import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// グローバルスタイル
const globalStyles = document.createElement('style');
globalStyles.textContent = `
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  
  body {
    font-family: 'Noto Sans JP', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  
  input:focus, textarea:focus {
    border-color: #2563eb !important;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
  }
  
  button:hover {
    filter: brightness(1.05);
  }
  
  button:active {
    transform: scale(0.98);
  }
  
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
`;
document.head.appendChild(globalStyles);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
