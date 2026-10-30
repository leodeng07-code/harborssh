import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './themes.css';
import './sftp.css';
import './readability.css';
import { applyInterfaceFontSize, readInterfaceFontSize } from './appearance';
import { applyTheme, readTheme } from './themes';
import { PasswordGate } from './components/PasswordGate';
import { initializeWallpapers } from './wallpaper-cache';

initializeWallpapers();
applyTheme(readTheme());
applyInterfaceFontSize(readInterfaceFontSize());
createRoot(document.getElementById('root')!).render(<React.StrictMode><PasswordGate><App /></PasswordGate></React.StrictMode>);
