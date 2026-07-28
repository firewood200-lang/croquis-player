const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('croquisAPI', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('window:setAlwaysOnTop', value),
  setOpacity: (value) => ipcRenderer.invoke('window:setOpacity', value),
  resizeToImage: (size) => ipcRenderer.invoke('window:resizeToImage', size),
  selectImages: () => ipcRenderer.invoke('dialog:selectImages'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  fileToUrl: (filePath) => ipcRenderer.invoke('file:toUrl', filePath),
  getDropPaths: (paths) => ipcRenderer.invoke('drop:getPaths', paths),
  onAddImages: (callback) => ipcRenderer.on('add-images', (_event, paths) => callback(paths)),
  onPassthroughChanged: (callback) => ipcRenderer.on('passthrough-changed', (_event, value) => callback(value)),
  // 2026-07-27: 창을 드래그해서 옮긴 뒤 마우스를 창 밖에서 놓으면 :hover가 멈춰버리는 문제 보정용 -
  // 메인 프로세스가 실제 커서 위치를 확인해 보내주는 신호(renderer.js의 setHoverActive 참고)
  onHoverCorrect: (callback) => ipcRenderer.on('hover-correct', (_event, inside) => callback(inside)),
  setRefVisible: (value) => ipcRenderer.invoke('window:setRefVisible', value),
  onRefVisibleChanged: (callback) => ipcRenderer.on('ref-visible-changed', (_event, value) => callback(value)),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('window:exitFullscreen'),
  onFullscreenChanged: (callback) => ipcRenderer.on('fullscreen-changed', (_event, value) => callback(value)),
  // 2026-07-17: 위성 창(통과 모드/레퍼런스 버튼)도 그림 위에 마우스가 있을 때 같이 나타나도록,
  // 이 창(mainWindow) 위에서의 hover 여부를 메인 프로세스에 알려 위성 창으로 전달한다.
  notifyHover: (value) => ipcRenderer.send('main-hover', value)
});
