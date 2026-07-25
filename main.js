const { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let mainWindow;
let toggleWin; // 항상 클릭 가능한 작은 위성 창 — 통과 모드(클릭 스루) on/off + 레퍼런스 표시 on/off 버튼.
               // 통과 모드 중에는 mainWindow 자체가 마우스를 안 받으므로, 다시 끄는 버튼은
               // 반드시 이 별도 창에 있어야 한다(곡선 원근 그리드 앱과 동일한 이유/구조).
let passthrough = false;
let refVisible = true; // 통과 모드 중에도(mainWindow가 클릭을 못 받는 상태에서도) 레퍼런스를
                        // 껐다 켤 수 있어야 해서, 메인 프로세스가 상태를 들고 두 창에 전파한다.
const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const videoExts = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const mediaExts = new Set([...imageExts, ...videoExts]);

// 외부(예: 레퍼런스 라이브러리)에서 실행 인자로 넘긴 이미지/동영상 경로(들) 추출
// - 폴더 전체를 넘길 때는 인자 개수 제한(OS 명령줄 길이 제한) 문제를 피하려고
//   {images, startIndex}가 담긴 임시 JSON 매니페스트 파일 경로 하나만 넘어온다.
// - 예전 방식(파일 경로를 인자로 직접 나열)도 계속 지원한다.
function getImagePathsFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const manifestArg = args.find(a => path.extname(a).toLowerCase() === '.json');
  if (manifestArg) {
    try {
      const data = JSON.parse(fs.readFileSync(manifestArg, 'utf-8'));
      if (Array.isArray(data.images)) {
        return { images: data.images.filter(p => mediaExts.has(path.extname(p).toLowerCase())), startIndex: data.startIndex || 0 };
      }
    } catch {}
    finally { try { fs.unlinkSync(manifestArg); } catch {} }
  }
  return { images: args.filter(a => mediaExts.has(path.extname(a).toLowerCase())), startIndex: 0 };
}

// 주의: 이 값은 반드시 requestSingleInstanceLock()에서 락을 획득한 인스턴스에서만 계산해야 한다.
// 락을 못 받고 곧 종료될 인스턴스가 여기서 먼저 매니페스트 파일을 읽어버리면(그리고 finally에서 삭제),
// 정작 락을 가진 기존 창이 second-instance 이벤트로 같은 파일을 읽으려 할 때 이미 삭제된 뒤라
// "이미지 0개"로 조용히 실패한다 - 더블클릭해도 크로키 뷰어가 안 넘어가던 버그의 원인이었음.
let pendingImages = { images: [], startIndex: 0 };

// 2026-07-18: 레퍼런스 라이브러리가 "--reflib-center=x,y" 형태로 자기 창의 화면 중심 좌표를
// 넘겨주면, 콜드 스타트로 새로 뜨는 크로키 창을 그 좌표에 정중앙 배치한다(기존엔 Electron 기본
// 동작대로 매번 주 모니터 중앙 등 예측 안 되는 위치에 떠서 "아무데나 뜬다"는 피드백이 있었음).
// 이미 실행 중이라 second-instance로 처리되는 경우엔 새 창을 안 띄우므로 이 값은 의미가 없다.
function extractCenterFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const centerArg = args.find(a => a.startsWith('--reflib-center='));
  if (!centerArg) return null;
  const [cx, cy] = centerArg.slice('--reflib-center='.length).split(',').map(Number);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return { cx, cy };
}
let pendingWindowPos = null;

// 주어진 중심점에 width x height 창을 놓을 좌상단 좌표를 계산하되, 그 중심점이 속한 모니터의
// 작업영역을 벗어나지 않게 clamp한다(다른 모니터 경계 근처에서 창이 화면 밖으로 잘리는 것 방지).
function computeCenteredPosition(cx, cy, width, height) {
  try {
    const display = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
    const area = display.workArea;
    let x = Math.round(cx - width / 2);
    let y = Math.round(cy - height / 2);
    x = Math.max(area.x, Math.min(x, area.x + area.width - width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - height));
    return { x, y };
  } catch { return null; }
}

function createWindow() {
  const winWidth = 760, winHeight = 620;
  const winOpts = {
    width: winWidth,
    height: winHeight,
    minWidth: 280,
    minHeight: 220,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    backgroundColor: '#090909',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };
  if (pendingWindowPos) {
    const pos = computeCenteredPosition(pendingWindowPos.cx, pendingWindowPos.cy, winWidth, winHeight);
    if (pos) { winOpts.x = pos.x; winOpts.y = pos.y; }
  }
  mainWindow = new BrowserWindow(winOpts);

  mainWindow.loadFile('index.html');

  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingImages.images.length) {
      mainWindow.webContents.send('add-images', pendingImages);
      pendingImages = { images: [], startIndex: 0 };
    }
  });

  mainWindow.on('move', positionToggleWindow);
  mainWindow.on('resize', positionToggleWindow);
  mainWindow.on('focus', () => toggleWin?.moveTop());
  mainWindow.on('minimize', () => toggleWin?.hide());
  mainWindow.on('restore', () => toggleWin?.show());
  mainWindow.on('closed', () => { toggleWin?.close(); toggleWin = null; });
  // 전체화면 버튼(툴바) 상태 동기화 - OS 단축키나 다른 경로로 전체화면이 바뀌어도
  // 렌더러의 버튼 활성 표시가 항상 실제 창 상태를 따라가게 한다.
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('fullscreen-changed', true));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('fullscreen-changed', false));
}

// 통과(클릭 스루) 모드 — 켜면 mainWindow가 마우스·펜 입력을 그대로 아래 창(클립스튜디오 등)으로
// 흘려보낸다. 곡선 원근 그리드 앱과 동일한 이유로, 다시 끄는 버튼은 mainWindow 밖의 별도
// 위성 창(toggleWin)에 둔다 — mainWindow 안의 버튼은 통과 모드 중엔 클릭을 받을 수 없기 때문.
function setPassthrough(value) {
  passthrough = !!value;
  mainWindow?.setIgnoreMouseEvents(passthrough, { forward: true });
  mainWindow?.webContents.send('passthrough-changed', passthrough);
  toggleWin?.webContents.send('passthrough-changed', passthrough);
  return passthrough;
}

// 레퍼런스(이미지/동영상) 표시 on/off — 예전에는 우측하단 버튼(메인 창 안)과 G키로만 껐다 켰는데,
// 통과 모드가 켜진 동안은 mainWindow 자체가 클릭을 못 받아 그 버튼도 눌리지 않는 문제가 있었다.
// 그래서 통과 모드 버튼과 같은 위성 창에 이 버튼도 같이 두어, 통과 모드 여부와 무관하게
// 항상 마우스로 켜고 끌 수 있게 한다.
function setRefVisible(value) {
  refVisible = !!value;
  mainWindow?.webContents.send('ref-visible-changed', refVisible);
  toggleWin?.webContents.send('ref-visible-changed', refVisible);
  return refVisible;
}

function positionToggleWindow() {
  if (!mainWindow || !toggleWin) return;
  const b = mainWindow.getBounds();
  // 창의 우측 하단 여백에 겹쳐 놓는다 - 이미지가 꽉 찬 상태에서도 구석의 빈 공간을 쓰도록.
  // 2026-07-17: #bottomBar(재생목록·카운터 텍스트, bottom:10px)와 겹쳐 보인다는 피드백으로
  // 46 -> 90으로 한 칸(+44px) 올림. style.css의 .cornerBtn(투명도 버튼) bottom 값도 같이 맞춰뒀다.
  // 2026-07-21~22: 동영상 재생 중일 때만 #videoControls와 안 겹치게 90 -> 158까지 여러 차례
  // 올렸다 내렸다 했었지만, 2026-07-23에 프레임바 자체를 상단 메뉴처럼 압축해 .cornerBtn과
  // 같은 줄(하단바 바로 위, bottom:51px)에 넣는 통합 레이아웃으로 바꾸면서, 이미지/동영상
  // 구분 없이 항상 같은 90으로 고정한다 - videoActive 분기(및 이를 위한 IPC)는 더 이상 필요 없어 제거.
  const offset = 90;
  toggleWin.setPosition(Math.round(b.x + b.width - 104), Math.round(b.y + b.height - offset));
}

function createToggleWindow() {
  toggleWin = new BrowserWindow({
    width: 100,
    height: 44,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-toggle.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  toggleWin.loadFile('passthrough-toggle.html');
  toggleWin.setAlwaysOnTop(true, 'screen-saver');
  positionToggleWindow();
  // (2026-07-21에 여기 있던 hide/show + 리사이즈 강제 다시 그리기 코드는 "창이 처음에 화면에
  // 합성이 안 된다"는 잘못된 진단에 따른 우회책이었다. 2026-07-22에 진짜 원인을 찾았다 -
  // renderer.js의 mouseenter가 커서가 이미 창 안에 있는 상태로 시작하면 발생하지 않는 문제였고,
  // 그건 mainWindow의 renderer.js에 mousemove 보완을 추가해 근본적으로 고쳤다. 그래서 여기 있던
  // 우회책은 불필요한 깜빡임만 만들어 제거했다.)
}

// 중복 실행 방지: 이미 켜져 있으면 새 인스턴스는 종료하고, 넘어온 이미지만 기존 창에 전달
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 락을 획득한 경우에만 자기 자신의 실행 인자(콜드 스타트 시 넘어온 이미지/중심좌표)를 파싱한다
  pendingImages = getImagePathsFromArgv(process.argv);
  pendingWindowPos = extractCenterFromArgv(process.argv);
  app.on('second-instance', (event, argv) => {
    const imgs = getImagePathsFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (imgs.images.length) mainWindow.webContents.send('add-images', imgs);
    }
  });
  app.whenReady().then(() => {
    createWindow();
    createToggleWindow();
    // F9: 어느 창에 포커스가 있든(클립스튜디오 등 다른 창이 활성 상태여도) 통과 모드를 켜고 끌 수 있는 전역 단축키
    globalShortcut.register('F9', () => setPassthrough(!passthrough));
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:setAlwaysOnTop', (_e, value) => {
  mainWindow?.setAlwaysOnTop(!!value, 'screen-saver');
  return mainWindow?.isAlwaysOnTop();
});
ipcMain.handle('window:setOpacity', (_e, value) => {
  const v = Math.max(0.15, Math.min(1, +value));
  mainWindow?.setOpacity(v);
  return mainWindow?.getOpacity();
});
ipcMain.handle('window:setPassthrough', (_e, value) => setPassthrough(value));
ipcMain.handle('window:setRefVisible', (_e, value) => setRefVisible(value));
ipcMain.handle('window:toggleFullscreen', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});
ipcMain.handle('window:exitFullscreen', () => {
  if (mainWindow?.isFullScreen()) mainWindow.setFullScreen(false);
  return false;
});

// 2026-07-17: 메인 창(그림) 위에 마우스가 있는지 위성 창(통과 모드/레퍼런스 버튼)에 전달 -
// 위성 창 버튼이 "그림 위에 마우스를 올렸을 때"도 같이 나타나게 하기 위함(위성 창은 화면
// 모서리에 겹쳐진 아주 작은 별도 창이라, 그 창 자체만 hover해서는 이 요구를 못 채움).
ipcMain.on('main-hover', (_e, value) => {
  toggleWin?.webContents.send('main-hover-changed', !!value);
});

// 그림 비율에 맞게 창 크기 자동 조정(설정에서 켠 경우에만 렌더러가 호출).
// 화면 작업 영역의 70%를 넘지 않게 제한해서, 큰 원본 이미지라도 "너무 크게"는 되지 않는다.
ipcMain.handle('window:resizeToImage', (_e, { width, height }) => {
  if (!mainWindow || !width || !height) return;
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const work = display.workAreaSize;
  const maxW = Math.round(work.width * 0.49); // 화면의 70% 크기였던 걸 다시 70%만큼 줄임(0.7 x 0.7 ≈ 0.49)
  const maxH = Math.round(work.height * 0.49);
  const scale = Math.min(maxW / width, maxH / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  mainWindow.setContentSize(w, h);
});

ipcMain.handle('dialog:selectImages', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '이미지/동영상 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images & Videos', extensions: Array.from(mediaExts).map(e => e.slice(1)) }]
  });
  if (result.canceled) return [];
  return result.filePaths;
});

function collectImagesFromFolder(folder) {
  const out = [];
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (mediaExts.has(path.extname(entry.name).toLowerCase())) out.push(full);
      }
    } catch {}
  }
  walk(folder);
  return out;
}

ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '이미지 폴더 선택',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { folder: '', images: [] };
  const folder = result.filePaths[0];
  return { folder, images: collectImagesFromFolder(folder) };
});

ipcMain.handle('file:toUrl', (_e, filePath) => {
  // 파일명에 #, %, ? 등이 있으면 단순 문자열 조합으로는 URL이 깨진다(#은 fragment 구분자로 해석됨) - pathToFileURL이 올바르게 인코딩해줌
  try { return pathToFileURL(filePath).href; }
  catch { return `file://${filePath.replace(/\\/g, '/')}`; }
});

ipcMain.handle('drop:getPaths', (_e, items) => {
  const results = [];
  for (const item of items) {
    const fpath = item;
    try {
      const stat = fs.statSync(fpath);
      if (stat.isDirectory()) {
        results.push(...collectImagesFromFolder(fpath));
      } else if (mediaExts.has(path.extname(fpath).toLowerCase())) {
        results.push(fpath);
      }
    } catch {}
  }
  return results;
});
