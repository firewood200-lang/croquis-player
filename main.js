const { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let mainWindow;
// 2026-08-14: 통과 모드/레퍼런스 표시 토글용 위성 창(toggleWin)을 완전히 제거했다. 참고 이미지
// 창 구석에 항상 겹쳐 있어야 해서(클릭 가능해야 하니 클릭 스루가 안 됨) 그 자리가 클립스튜디오로
// 마우스를 못 넘기는 사각지대가 되는 문제가 있었고, 자리를 옮겨도 여전히 방해된다는 피드백에
// 사용자가 "버튼을 거의 안 쓴다"며 아예 제거를 택함. 통과 모드는 F9(전역 단축키, 어느 창에
// 포커스가 있든 항상 동작)로, 레퍼런스 표시는 G(이 창에 포커스가 있을 때만 동작, renderer.js)로
// 계속 켜고 끌 수 있다 — 마우스로 누르는 버튼만 없어진 것.
let passthrough = false;
let refVisible = true;
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

  mainWindow.on('move', scheduleHoverCorrection);
  // 전체화면 버튼(툴바) 상태 동기화 - OS 단축키나 다른 경로로 전체화면이 바뀌어도
  // 렌더러의 버튼 활성 표시가 항상 실제 창 상태를 따라가게 한다.
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('fullscreen-changed', true));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('fullscreen-changed', false));
}

// 통과(클릭 스루) 모드 — 켜면 mainWindow가 마우스·펜 입력을 그대로 아래 창(클립스튜디오 등)으로
// 흘려보낸다. F9(전역 단축키)로만 켜고 끈다 — 예전엔 별도 위성 창(toggleWin)의 마우스 버튼으로도
// 껐었지만, 그 위성 창이 참고 이미지 창과 겹쳐 있어 클립스튜디오로 마우스를 못 넘기는 사각지대를
// 만드는 문제 때문에 2026-08-14에 위성 창 자체를 없앴다(자세한 배경은 아래 forward 관련 설명 참고).
//
// 2026-08-14(1차): forward:true였던 이전 방식을 forward:false로 바꿈. Windows에서
// setIgnoreMouseEvents(true, {forward:true})를 쓰면 이 창과 그 아래 창(클립스튜디오 등)의
// 커서 설정이 서로 충돌해서, 아래 창이 자기 커스텀 커서(브러시 등)를 못 그리고 OS 기본
// 화살표로 튀는 문제가 있다는 게 확인됨(Electron 공식 이슈 #35414 - forward 옵션이 원인,
// Electron 팀은 "not planned"로 고칠 계획 없음이라 앱 쪽에서 우회해야 함).
function setPassthrough(value) {
  passthrough = !!value;
  mainWindow?.setIgnoreMouseEvents(passthrough, { forward: false });
  mainWindow?.webContents.send('passthrough-changed', passthrough);
  return passthrough;
}

// 레퍼런스(이미지/동영상) 표시 on/off — G 키(이 창에 포커스가 있을 때만 동작, renderer.js)로 켜고 끈다.
function setRefVisible(value) {
  refVisible = !!value;
  mainWindow?.webContents.send('ref-visible-changed', refVisible);
  return refVisible;
}

// 2026-07-27: 창을 드래그해서 옮긴 뒤 마우스 버튼을 창 "바깥"에서 놓으면, 렌더러가 그 사이에
// 아무 이벤트도 못 받아서(OS가 네이티브 드래그를 처리하는 동안 렌더러 이벤트 스트림이 끊김)
// 크로미움의 :hover 판정이 "커서가 계속 창 안에 있다"로 멈춰버리는 문제가 있었다(메뉴가 안
// 사라지는 버그의 원인). 그래서 창이 움직임을 멈춘 직후(연속된 move 이벤트가 250ms간 없을 때)
// 실제 커서의 화면 좌표를 확인해서, 창 밖에 있으면 렌더러에 "hover 아님"을 강제로 알려준다.
let hoverCheckTimer = null;
function scheduleHoverCorrection() {
  clearTimeout(hoverCheckTimer);
  hoverCheckTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = mainWindow.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    mainWindow.webContents.send('hover-correct', inside);
  }, 250);
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

// 현재 보고 있는 이미지를 OS 클립보드로 복사 - 클립스튜디오 등 다른 프로그램에 바로 붙여넣기용.
// 동영상은 렌더러 쪽에서 아예 이 IPC를 안 부르게 막아두므로 여기서는 이미지 파일만 들어온다.
ipcMain.handle('clipboard:copyImage', (_e, filePath) => {
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return { success: false, message: '이미지를 읽을 수 없습니다.' };
    clipboard.writeImage(img);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
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
