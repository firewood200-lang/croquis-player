const { contextBridge, ipcRenderer } = require('electron');

// 통과 모드 위성 창(passthrough-toggle.html) 전용 preload — 메인 창 preload(croquisAPI)와
// 분리해둔다. 이 창은 항상 클릭이 되어야 하는, 딱 이 버튼 하나만을 위한 작은 창이라
// 굳이 메인 API 전부를 노출할 필요가 없다.
contextBridge.exposeInMainWorld('toggleAPI', {
  setPassthrough: (value) => ipcRenderer.invoke('window:setPassthrough', value),
  onPassthroughChanged: (callback) => ipcRenderer.on('passthrough-changed', (_e, value) => callback(value)),
  setRefVisible: (value) => ipcRenderer.invoke('window:setRefVisible', value),
  onRefVisibleChanged: (callback) => ipcRenderer.on('ref-visible-changed', (_e, value) => callback(value)),
  // 2026-07-17: 버튼을 평소엔 숨겨뒀다가, 메인 창(그림) 위에 마우스가 있을 때도 같이 나타나도록.
  // 이 창은 메인 창과 겹치는 아주 작은 모서리 영역이라, 이 창 자체를 직접 hover하는 것만으로는
  // "그림 위에 마우스를 올리면 보인다"는 요구를 충분히 만족 못 해서 메인 창의 hover 상태를 전달받는다.
  onMainHoverChanged: (callback) => ipcRenderer.on('main-hover-changed', (_e, value) => callback(value))
});
