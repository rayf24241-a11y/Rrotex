const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rotexDesktop', {
  isDesktop: true,

  // File system
  openFolder: () => ipcRenderer.invoke('open-folder'),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  createFile: (filePath) => ipcRenderer.invoke('create-file', filePath),
  createFolder: (dirPath) => ipcRenderer.invoke('create-folder', dirPath),

  // Terminal
  execCommand: (command, cwd) => ipcRenderer.invoke('exec-command', command, cwd),

  // Utils
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
