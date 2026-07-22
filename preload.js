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
  setRefVisible: (value) => ipcRenderer.invoke('window:setRefVisible', value),
  onRefVisibleChanged: (callback) => ipcRenderer.on('ref-visible-changed', (_event, value) => callback(value)),
  // 2026-07-17: 위성 창(통과 모드/레퍼런스 버튼)도 그림 위에 마우스가 있을 때 같이 나타나도록,
  // 이 창(mainWindow) 위에서의 hover 여부를 메인 프로세스에 알려 위성 창으로 전달한다.
  notifyHover: (value) => ipcRenderer.send('main-hover', value),
  // 2026-07-22: 지금 보여주는 게 동영상인지 알려주면, 메인 프로세스가 위성 창(G/F9 버튼)과
  // .cornerBtn(투명도 버튼)을 이미지/동영상에 맞는 높이로 다시 놓는다.
  setVideoActive: (value) => ipcRenderer.send('video-active-changed', value)
});
