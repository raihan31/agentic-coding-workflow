const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  isDesktop: true,
  platform: process.platform,

  selectDirectory: async (defaultPath) => {
    return await ipcRenderer.invoke('desktop:select-directory', defaultPath);
  },

  selectFile: async (filters) => {
    return await ipcRenderer.invoke('desktop:select-file', filters);
  },

  openInEditor: async (filePath, line = 1, editor = 'vscode') => {
    return await ipcRenderer.invoke('desktop:open-in-editor', { filePath, line, editor });
  },

  sendNotification: (title, body) => {
    ipcRenderer.send('desktop:send-notification', { title, body });
  },

  openPath: async (filePath) => {
    return await ipcRenderer.invoke('desktop:open-path', filePath);
  },
});
