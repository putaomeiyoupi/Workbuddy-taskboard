import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { HostDiagHUD } from './components/HostDiagHUD';
import { APP_CONFIG } from './config';
import { installAutoReload } from './utils/autoReload';
import 'tdesign-react/esm/style/index.js';
import './index.css';

// 设置页面标题
document.title = APP_CONFIG.name;

/**
 * 长时运行自愈：看板要 7×24 挂着，浏览器侧累积必须定期清零。
 * 默认 6 小时重载一次（页面不可见时借机提前做，尽量不打断观看）；
 * 关闭或在控制台调间隔见 `kanbanAutoReload`，详见 `src/utils/autoReload.ts`。
 */
installAutoReload();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      {/* 宿主嵌入环境的性能诊断浮层：只在 iframe 内渲染（普通浏览器看不到） */}
      <HostDiagHUD />
    </BrowserRouter>
  </React.StrictMode>,
);
