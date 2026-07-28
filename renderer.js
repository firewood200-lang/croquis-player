const $ = (id) => document.getElementById(id);

const state = {
  playlists: [{ name: '기본 재생목록', images: [] }],
  activePlaylist: 0,
  activeIndex: 0,
  running: false,
  remaining: 120,
  timerId: null,
  warningAudioId: null,
  warned: false,
  audioCtx: null,
  settings: {
    duration: 120,
    warningAt: 30,
    alwaysTop: true,
    random: false,
    repeat: true,
    autoStart: false,
    menuAutoHide: true,
    fit: 'contain',
    autoResizeWindow: false, // 그림 비율에 맞게 창 크기 자동 조정 (기본은 꺼둠 - 크로키 타이머로 자동 전환할 때 창이 계속 움직이면 방해될 수 있어서)
    levels: { gray: false, black: 0, gamma: 1, white: 255 }, // 클립스튜디오 "레벨 보정"과 같은 개념: 블랙/화이트 포인트 + 감마
    sound: true,
    flash: true,
    volume: 0.35,
    flashAlpha: 0.24,
    videoSpeed: 1 // 동영상 재생 속도(마지막으로 고른 값을 기억)
  }
};

const els = {
  imageView: $('imageView'), emptyState: $('emptyState'), timerBadge: $('timerBadge'), redFlash: $('redFlash'), zoomBadge: $('zoomBadge'),
  btnAddImages: $('btnAddImages'), btnAddFolder: $('btnAddFolder'), btnPrev: $('btnPrev'), btnPlay: $('btnPlay'), btnNext: $('btnNext'), btnSettings: $('btnSettings'), btnMin: $('btnMin'), btnClose: $('btnClose'), btnPin: $('btnPin'), btnFullscreen: $('btnFullscreen'), btnCopyImage: $('btnCopyImage'),
  navPrev: $('navPrev'), navNext: $('navNext'),
  playlistName: $('playlistName'), imageCounter: $('imageCounter'), modeLabel: $('modeLabel'), settingsDialog: $('settingsDialog'), playlistSelect: $('playlistSelect'), imageList: $('imageList'),
  videoView: $('videoView'), videoControls: $('videoControls'), btnFramePrev: $('btnFramePrev'), btnVideoPlay: $('btnVideoPlay'), btnFrameNext: $('btnFrameNext'),
  centerPlayBtn: $('centerPlayBtn'), centerPlayIcon: $('centerPlayIcon'),
  videoSeek: $('videoSeek'), videoTime: $('videoTime'), videoSpeedSelect: $('videoSpeedSelect'),
  btnOpacity: $('btnOpacity'), opacityVal: $('opacityVal')
};

// ---- 동영상 파일 판별 (레퍼런스 라이브러리에서 넘어오는 mp4/webm/mov/m4v 포함) ----
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
function isVideoPath(p) {
  const i = p.lastIndexOf('.');
  return i >= 0 && VIDEO_EXTS.has(p.slice(i).toLowerCase());
}
// 프레임 이동 시 이동할 시간(초). 실제 fps를 알 수 없어 30fps 기준 근사치를 사용한다(대부분의 참고 영상에 무난함).
const FRAME_STEP = 1 / 30;

// ---- 마우스 휠 확대/축소 + 손바닥(드래그) 이동 ----
// transform-origin은 항상 중앙 고정. panX/panY(화면 px 단위 이동량) + zoomLevel(배율)로 위치와 크기를 함께 관리한다.
let zoomLevel = 1;
let panX = 0, panY = 0;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let panOrigin = { x: 0, y: 0 };
let zoomBadgeTimer = null;
// 좌우반전(미러) - 레퍼런스 라이브러리에 연동된 앱들(곡선 원근 그리드, OBJ 배치 뷰어)과 공통되는
// 단축키 F로 통일했다(2026-07-17). 그림을 뒤집어 보면 눈에 익어 못 보던 비율 오류를 잡기 쉬워
// 크로키 참고 이미지에 특히 유용한 기능이다. 다음/이전 이미지로 넘어가도(줌/이동과 달리) 유지된다.
let mirrored = false;

els.imageView.style.transformOrigin = '50% 50%';
els.imageView.style.cursor = 'grab';
els.imageView.draggable = false; // 네이티브 이미지 드래그(고스트) 방지 - 손바닥 이동과 충돌함

function applyTransform() {
  const sx = zoomLevel * (mirrored ? -1 : 1);
  els.imageView.style.transform = `translate(${panX}px, ${panY}px) scale(${sx}, ${zoomLevel})`;
}
function applyVideoMirror() {
  els.videoView.style.transform = mirrored ? 'scaleX(-1)' : '';
}
function setMirrored(v) {
  mirrored = v;
  applyTransform();
  applyVideoMirror();
}
function showZoomBadge() {
  els.zoomBadge.textContent = Math.round(zoomLevel * 100) + '%';
  els.zoomBadge.classList.add('show');
  clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = setTimeout(() => els.zoomBadge.classList.remove('show'), 900);
}
function resetZoom() {
  zoomLevel = 1; panX = 0; panY = 0;
  applyTransform();
  els.zoomBadge.classList.remove('show');
}

els.imageView.addEventListener('wheel', (e) => {
  if (els.imageView.style.display === 'none') return;
  e.preventDefault();
  // 화면 중앙 기준 좌표계에서, 커서가 가리키는 이미지 상의 지점이 확대/축소 후에도 같은 화면 위치에 남도록 계산
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const ox = (e.clientX - cx - panX) / zoomLevel;
  const oy = (e.clientY - cy - panY) / zoomLevel;
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const newZoom = Math.max(1, Math.min(8, zoomLevel * factor));
  panX = e.clientX - cx - newZoom * ox;
  panY = e.clientY - cy - newZoom * oy;
  zoomLevel = newZoom;
  if (zoomLevel === 1) { panX = 0; panY = 0; } // 100%로 돌아오면 중앙 정렬로 리셋
  applyTransform();
  showZoomBadge();
}, { passive: false });

els.imageView.addEventListener('dblclick', resetZoom);

els.imageView.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  isPanning = true;
  panStart = { x: e.clientX, y: e.clientY };
  panOrigin = { x: panX, y: panY };
  els.imageView.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (!isPanning) return;
  panX = panOrigin.x + (e.clientX - panStart.x);
  panY = panOrigin.y + (e.clientY - panStart.y);
  applyTransform();
});
window.addEventListener('mouseup', () => {
  if (isPanning) {
    isPanning = false;
    els.imageView.style.cursor = 'grab';
  }
});

function currentPlaylist() { return state.playlists[state.activePlaylist]; }

function save() {
  localStorage.setItem('croquisPlayerState', JSON.stringify({
    playlists: state.playlists,
    activePlaylist: state.activePlaylist,
    activeIndex: state.activeIndex,
    settings: state.settings
  }));
}

function load() {
  const raw = localStorage.getItem('croquisPlayerState');
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data.playlists) && data.playlists.length) state.playlists = data.playlists;
    state.activePlaylist = Math.min(data.activePlaylist || 0, state.playlists.length - 1);
    state.activeIndex = data.activeIndex || 0;
    state.settings = { ...state.settings, ...(data.settings || {}) };
    state.remaining = state.settings.duration;
  } catch {}
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(sec) { return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`; }

async function showImage() {
  const list = currentPlaylist().images;
  if (!list.length) {
    els.imageView.style.display = 'none';
    stopCurrentVideo();
    els.videoControls.classList.remove('show');
    els.centerPlayBtn.classList.remove('show');
    els.emptyState.style.display = 'flex';
    updateUI();
    return;
  }
  state.activeIndex = Math.max(0, Math.min(state.activeIndex, list.length - 1));
  const currentPath = list[state.activeIndex];
  const url = await window.croquisAPI.fileToUrl(currentPath);
  if (isVideoPath(currentPath)) {
    els.imageView.style.display = 'none';
    els.videoView.src = url;
    els.videoView.playbackRate = state.settings.videoSpeed || 1;
    els.videoSpeedSelect.value = String(state.settings.videoSpeed || 1);
    els.videoView.style.display = 'block';
    els.videoControls.classList.add('show');
    els.centerPlayBtn.classList.add('show');
    applyVideoMirror(); // 좌우반전 상태를 새로 불러온 영상에도 그대로 유지
  } else {
    stopCurrentVideo();
    els.videoControls.classList.remove('show');
    els.centerPlayBtn.classList.remove('show');
    // 창 크기 자동 조정이 켜져 있으면, 이미지가 실제로 로드된 뒤(원본 픽셀 크기를 알 수 있을 때) 창을 그 비율에 맞춰 다시 잡는다.
    // src를 넣기 전에 먼저 걸어둬야 캐시된 이미지가 곧바로 로드돼도 놓치지 않는다.
    els.imageView.onload = state.settings.autoResizeWindow
      ? () => window.croquisAPI.resizeToImage({ width: els.imageView.naturalWidth, height: els.imageView.naturalHeight })
      : null;
    els.imageView.src = url;
    els.imageView.style.display = 'block';
    resetZoom();
  }
  els.emptyState.style.display = 'none';
  updateUI();
  save();
}

// 다음/이전 이미지로 넘어가거나 재생목록이 비었을 때, 재생 중이던 동영상을 확실히 멈추고 리소스를 반납한다
function stopCurrentVideo() {
  if (!els.videoView.src) return;
  els.videoView.pause();
  els.videoView.removeAttribute('src');
  els.videoView.load();
}

function updateUI() {
  els.timerBadge.textContent = fmt(state.remaining);
  els.timerBadge.classList.toggle('show', state.running);
  els.timerBadge.classList.toggle('warning', state.running && state.remaining <= state.settings.warningAt && state.remaining > 0);
  els.btnPlay.textContent = state.running ? '정지' : '시작';
  els.playlistName.textContent = currentPlaylist().name;
  els.imageCounter.textContent = `${currentPlaylist().images.length ? state.activeIndex + 1 : 0} / ${currentPlaylist().images.length}`;
  els.modeLabel.textContent = state.settings.random ? '랜덤' : '순서';
  els.imageView.className = state.settings.fit === 'cover' ? 'cover' : state.settings.fit === 'none' ? 'none' : '';
  document.documentElement.style.setProperty('--flash-alpha', state.settings.flashAlpha);
  document.body.classList.toggle('menuPinned', !state.settings.menuAutoHide);
  // 캔버스 좌우 화살표: 더 갈 곳이 없으면(맨 앞/맨 뒤, 반복 꺼짐) 흐리게 숨겨서 눌러도 아무 일 없다는 걸 알려준다
  const navLen = currentPlaylist().images.length;
  els.navPrev.disabled = navLen <= 1 || state.activeIndex <= 0;
  els.navNext.disabled = navLen <= 1 || (!state.settings.random && !state.settings.repeat && state.activeIndex >= navLen - 1);
  updateLevelsFilter();
  fillSettings();
}

function getAudioCtx() {
  if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.audioCtx;
}
function beep(freq = 740, dur = 0.12, gain = 0.15) {
  if (!state.settings.sound) return;
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine'; osc.frequency.value = freq;
  osc.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0, ctx.currentTime);
  g.gain.linearRampToValueAtTime(gain * state.settings.volume, ctx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  osc.start(); osc.stop(ctx.currentTime + dur + 0.02);
}
function startWarningSound() {
  stopWarningSound();
  beep(520, .12, .20);
  state.warningAudioId = setInterval(() => beep(520, .10, .18), 750);
}
function stopWarningSound() { if (state.warningAudioId) clearInterval(state.warningAudioId); state.warningAudioId = null; }
function finishSound() { beep(980, .18, .26); setTimeout(() => beep(660, .18, .22), 220); }
function setWarningVisual(on) { els.redFlash.classList.toggle('active', on && state.settings.flash); }

// resetTime=true: 새 이미지로 넘어갈 때처럼 항상 설정된 기본 시간으로 처음부터 다시 시작
// resetTime=false: 일시정지 눌렀다가 다시 시작할 때처럼, 멈췄던 시점의 남은 시간(state.remaining)부터 이어서 진행
function startTimer(resetTime = true) {
  if (!currentPlaylist().images.length) return;
  getAudioCtx();
  stopTimer(false);
  state.running = true;
  if (resetTime) {
    state.warned = false;
    state.remaining = state.settings.duration;
  } else if (state.remaining <= state.settings.warningAt && state.remaining > 0) {
    // 일시정지 시 꺼졌던 경고음/점멸을, 아직 경고 구간(remaining <= warningAt)이면 다시 켜준다
    state.warned = true;
    startWarningSound();
    setWarningVisual(true);
  }
  updateUI();
  state.timerId = setInterval(() => {
    state.remaining -= 1;
    if (state.remaining <= state.settings.warningAt && state.remaining > 0 && !state.warned) {
      state.warned = true; startWarningSound(); setWarningVisual(true);
    }
    if (state.remaining <= 0) {
      state.remaining = 0;
      stopWarningSound(); setWarningVisual(false); finishSound();
      nextImage(true);
      return;
    }
    updateUI();
  }, 1000);
}
function stopTimer(resetVisual = true) {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null; state.running = false; stopWarningSound();
  if (resetVisual) setWarningVisual(false);
  updateUI();
}
// 일시정지 후 '시작'을 다시 누르면 초기화된 시간이 아니라 멈춘 시점의 남은 시간부터 이어서 진행되도록
// resetTime=false로 startTimer를 호출한다 (다음/이전 이미지로 넘어갈 때의 startTimer() 기본 호출은 그대로 매번 리셋)
function togglePlay() { state.running ? stopTimer() : startTimer(false); }

function nextIndex() {
  const len = currentPlaylist().images.length;
  if (!len) return 0;
  if (state.settings.random) return Math.floor(Math.random() * len);
  if (state.activeIndex < len - 1) return state.activeIndex + 1;
  return state.settings.repeat ? 0 : state.activeIndex;
}
async function nextImage(fromTimer = false) {
  const len = currentPlaylist().images.length;
  if (!len) return;
  const old = state.activeIndex;
  state.activeIndex = nextIndex();
  await showImage();
  if (!state.settings.repeat && old === state.activeIndex && old === len - 1 && !state.settings.random) {
    stopTimer(); save(); return;
  }
  if (fromTimer) startTimer();
}
async function prevImage() {
  if (!currentPlaylist().images.length) return;
  state.activeIndex = Math.max(0, state.activeIndex - 1);
  await showImage();
  if (state.running) startTimer();
}

async function addImagesToPlaylist(paths) {
  if (!paths || !paths.length) return;
  const p = currentPlaylist();
  p.images.push(...paths.filter(Boolean));
  state.activeIndex = Math.min(state.activeIndex, p.images.length - 1);
  await showImage(); renderLists(); save();
}

// 외부 앱(레퍼런스 라이브러리 등)에서 더블클릭으로 넘어온 이미지: 재생목록을 이 폴더의 이미지들로
// "교체"하고 더블클릭한 이미지로 바로 이동한다. (예전에는 push로 계속 누적만 시켰는데, 그러면
// 다음/이전을 누를 때 몇 세션 전에 열어봤던 다른 폴더의 이미지까지 섞여서 나오는 문제가 있었음)
async function addImagesFromExternal(payload) {
  // 하위 호환: 예전 방식(문자열 경로 배열)도 계속 지원 - 이 경우는 기존처럼 추가만 한다
  if (Array.isArray(payload)) {
    if (!payload.length) return;
    const p = currentPlaylist();
    const startIdx = p.images.length;
    p.images.push(...payload.filter(Boolean));
    state.activeIndex = startIdx;
    await showImage(); renderLists(); save();
    return;
  }
  const { images, startIndex } = payload || {};
  if (!images || !images.length) return;
  const p = currentPlaylist();
  p.images = images.filter(Boolean);
  state.activeIndex = Math.max(0, Math.min(startIndex || 0, p.images.length - 1));
  await showImage(); renderLists(); save();
}
async function chooseImages() { addImagesToPlaylist(await window.croquisAPI.selectImages()); }
async function chooseFolder() { const res = await window.croquisAPI.selectFolder(); addImagesToPlaylist(res.images || []); }

// 드래그앤드롭
document.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
document.addEventListener('drop', async (e) => {
  e.preventDefault(); e.stopPropagation();
  const paths = Array.from(e.dataTransfer.files).map(f => f.path);
  if (!paths.length) return;
  const images = await window.croquisAPI.getDropPaths(paths);
  addImagesToPlaylist(images);
});

function renderLists() {
  els.playlistSelect.innerHTML = '';
  state.playlists.forEach((p, i) => {
    const opt = document.createElement('option'); opt.value = i; opt.textContent = `${p.name} (${p.images.length})`; els.playlistSelect.appendChild(opt);
  });
  els.playlistSelect.value = state.activePlaylist;
  els.imageList.innerHTML = '';
  currentPlaylist().images.forEach((img, i) => {
    const opt = document.createElement('option'); opt.value = i; opt.textContent = img.split(/[\\/]/).pop(); opt.title = img; els.imageList.appendChild(opt);
  });
}

// 클립스튜디오 "레벨 보정"과 같은 계산: 블랙/화이트 포인트로 먼저 선형으로 늘린 뒤, 감마로 중간톤을 조정한다.
// SVG feComponentTransfer 두 단계(linear -> gamma)로 나눠서, #imageView/#videoView에 이미 걸려있는
// filter: url(#croquisLevels) 하나로 실시간 적용된다(그림이 바뀌어도 다시 설정할 필요 없음).
function updateLevelsFilter(lv = state.settings.levels) {
  const black = Math.min(lv.black, lv.white - 1) / 255;
  const white = lv.white / 255;
  const span = Math.max(white - black, 0.001);
  const slope = 1 / span;
  const intercept = -black / span;
  const exponent = 1 / Math.max(lv.gamma, 0.01);
  $('lvGray').setAttribute('values', lv.gray ? '0' : '1');
  ['lvLinearR', 'lvLinearG', 'lvLinearB'].forEach(id => {
    $(id).setAttribute('slope', slope);
    $(id).setAttribute('intercept', intercept);
  });
  ['lvGammaR', 'lvGammaG', 'lvGammaB'].forEach(id => $(id).setAttribute('exponent', exponent));
}

function fillSettings() {
  $('durationInput').value = state.settings.duration;
  $('warningInput').value = state.settings.warningAt;
  $('alwaysTopCheck').checked = state.settings.alwaysTop;
  $('randomCheck').checked = state.settings.random;
  $('repeatCheck').checked = state.settings.repeat;
  $('autoStartCheck').checked = state.settings.autoStart;
  $('menuAutoHideCheck').checked = state.settings.menuAutoHide;
  $('fitSelect').value = state.settings.fit;
  $('autoResizeCheck').checked = state.settings.autoResizeWindow;
  $('grayscaleCheck').checked = state.settings.levels.gray;
  $('levelBlackInput').value = state.settings.levels.black;
  $('levelGammaInput').value = Math.round(state.settings.levels.gamma * 100);
  $('levelWhiteInput').value = state.settings.levels.white;
  $('levelBlackVal').textContent = state.settings.levels.black;
  $('levelGammaVal').textContent = state.settings.levels.gamma.toFixed(2);
  $('levelWhiteVal').textContent = state.settings.levels.white;
  $('btnGrayToggle').classList.toggle('active', state.settings.levels.gray);
  els.btnPin.classList.toggle('active', state.settings.alwaysTop);
  $('soundCheck').checked = state.settings.sound;
  $('flashCheck').checked = state.settings.flash;
  $('volumeInput').value = state.settings.volume;
  $('flashAlphaInput').value = state.settings.flashAlpha;
  renderLists();
}

function applySettingsFromForm() {
  state.settings.duration = Math.max(5, parseInt($('durationInput').value) || 120);
  state.settings.warningAt = Math.max(1, parseInt($('warningInput').value) || 30);
  state.settings.alwaysTop = $('alwaysTopCheck').checked;
  state.settings.random = $('randomCheck').checked;
  state.settings.repeat = $('repeatCheck').checked;
  state.settings.autoStart = $('autoStartCheck').checked;
  state.settings.menuAutoHide = $('menuAutoHideCheck').checked;
  state.settings.fit = $('fitSelect').value;
  state.settings.autoResizeWindow = $('autoResizeCheck').checked;
  state.settings.levels = {
    gray: $('grayscaleCheck').checked,
    black: parseInt($('levelBlackInput').value) || 0,
    gamma: (parseInt($('levelGammaInput').value) || 100) / 100,
    white: parseInt($('levelWhiteInput').value) || 255
  };
  updateLevelsFilter();
  state.settings.sound = $('soundCheck').checked;
  state.settings.flash = $('flashCheck').checked;
  state.settings.volume = parseFloat($('volumeInput').value);
  state.settings.flashAlpha = parseFloat($('flashAlphaInput').value);
  state.remaining = state.settings.duration;
  window.croquisAPI.setAlwaysOnTop(state.settings.alwaysTop);
  els.btnPin.classList.toggle('active', state.settings.alwaysTop);
  save(); updateUI();
}

els.btnAddImages.onclick = chooseImages;
els.btnAddFolder.onclick = chooseFolder;
els.btnPrev.onclick = prevImage;
els.btnNext.onclick = () => nextImage(false);
els.navPrev.onclick = prevImage;
els.navNext.onclick = () => nextImage(false);

// 2026-07-20: 예스24 이북처럼, 마우스가 그 쪽 가장자리 근처에 있을 때만 그 쪽 화살표만 보이게 한다
// (화면 전체에 마우스를 올리면 양쪽 다 보이던 이전 방식은 "그림보다 눈에 띈다"는 피드백으로 변경).
const NAV_EDGE_RATIO = 0.16; // 창 너비의 이 비율만큼 가장자리에 가까우면 그 쪽 화살표 표시
document.addEventListener('mousemove', (e) => {
  const edge = Math.max(60, window.innerWidth * NAV_EDGE_RATIO);
  document.body.classList.toggle('showNavLeft', e.clientX <= edge);
  document.body.classList.toggle('showNavRight', e.clientX >= window.innerWidth - edge);
});
document.addEventListener('mouseleave', () => {
  document.body.classList.remove('showNavLeft', 'showNavRight');
});
els.btnPlay.onclick = togglePlay;
els.btnSettings.onclick = () => { fillSettings(); els.settingsDialog.showModal(); };
els.btnMin.onclick = () => window.croquisAPI.minimize();
els.btnClose.onclick = () => window.croquisAPI.close();
els.btnPin.onclick = async () => {
  const next = !els.btnPin.classList.contains('active');
  const result = await window.croquisAPI.setAlwaysOnTop(next);
  state.settings.alwaysTop = result;
  els.btnPin.classList.toggle('active', result);
  els.btnPin.title = result ? '항상 위 고정 끄기' : '항상 위 고정 켜기';
  save();
};
els.btnFullscreen.onclick = async () => {
  const isFull = await window.croquisAPI.toggleFullscreen();
  els.btnFullscreen.classList.toggle('active', isFull);
  els.btnFullscreen.title = isFull ? '전체화면 끄기 (F11, Esc)' : '전체화면 켜기 (F11)';
};
// 현재 이미지를 클립보드로 복사 - alert로 매번 끊기 않도록, 버튼 텍스트를 잠깐 "복사됨!"으로
// 바꿔서 결과를 알려주고 원래 글자로 되돌린다. 동영상일 때는 애초에 복사할 게 없으니 안내만 한다.
let copyImageResetTimer = null;
els.btnCopyImage.onclick = async () => {
  const list = currentPlaylist().images;
  if (!list.length) return;
  const currentPath = list[state.activeIndex];
  if (isVideoPath(currentPath)) {
    alert('동영상은 복사할 수 없습니다. 이미지에서만 지원합니다.');
    return;
  }
  const result = await window.croquisAPI.copyImageToClipboard(currentPath);
  clearTimeout(copyImageResetTimer);
  els.btnCopyImage.textContent = result.success ? '복사됨!' : '실패';
  if (!result.success) console.error('이미지 복사 실패:', result.message);
  copyImageResetTimer = setTimeout(() => { els.btnCopyImage.textContent = '복사'; }, 900);
};
window.croquisAPI.onFullscreenChanged((value) => {
  els.btnFullscreen.classList.toggle('active', value);
  els.btnFullscreen.title = value ? '전체화면 끄기 (F11, Esc)' : '전체화면 켜기 (F11)';
});

// ---- 창 투명도(좌측하단 버튼) - 클립스튜디오 등 아래 창이 비쳐 보이도록 클릭마다 순환 ----
// 통과 모드(F9, 우측하단 위성 창)와 함께 쓰면: 투명도를 낮춰 아래 창을 보면서, 통과 모드로
// 마우스·펜을 그대로 통과시켜 바로 그림을 그릴 수 있다.
const OPACITY_LEVELS = [1, 0.8, 0.6, 0.4];
let opacityIdx = 0;
els.btnOpacity.onclick = async () => {
  opacityIdx = (opacityIdx + 1) % OPACITY_LEVELS.length;
  const level = OPACITY_LEVELS[opacityIdx];
  const applied = await window.croquisAPI.setOpacity(level);
  els.opacityVal.textContent = Math.round((applied ?? level) * 100) + '%';
};

// ---- 레퍼런스 표시 켜기/끄기(단축키 G) ----
// 타이머·재생목록 등 다른 상태는 그대로 두고, 이미지/동영상 화면 표시만 잠깐 껐다 켠다.
// 이 창 안에는 버튼을 따로 두지 않는다 - 통과 모드 중엔 이 창 자체가 클릭을 못 받아 버튼이
// 있어도 안 눌리고, 우측하단 위성 창(F9 옆의 👁 버튼)과 겹쳐 보이기만 해서 뺐다.
// G키는 통과 모드가 꺼져 있을 때만 동작하며(포커스가 이 창에 있을 때), 항상 확실히
// 켜고 끄려면 위성 창의 👁 버튼을 쓰면 된다. 여기서는 그 위성 창과 상태만 서로 맞춰준다.
let refVisible = true;
function applyRefVisible(v) {
  refVisible = v;
  document.body.classList.toggle('refHidden', !refVisible);
}
function setRefVisible(v) {
  applyRefVisible(v);
  window.croquisAPI.setRefVisible(v).catch(() => {}); // 위성 창 버튼 표시도 같이 맞춰줌
}
// 위성 창(F9 옆의 👁 버튼)에서 껐다 켰을 때 - 여기서는 다시 IPC를 보내지 않고 화면만 맞춘다
window.croquisAPI.onRefVisibleChanged((v) => applyRefVisible(v));
$('btnListAddImages').onclick = chooseImages;
$('btnListAddFolder').onclick = chooseFolder;
$('btnSaveSettings').onclick = () => { applySettingsFromForm(); els.settingsDialog.close(); };
$('btnNewPlaylist').onclick = () => { const name = prompt('재생목록 이름', '새 재생목록'); if (!name) return; state.playlists.push({ name, images: [] }); state.activePlaylist = state.playlists.length - 1; state.activeIndex = 0; renderLists(); showImage(); save(); };
$('btnRenamePlaylist').onclick = () => { const name = prompt('새 이름', currentPlaylist().name); if (!name) return; currentPlaylist().name = name; renderLists(); updateUI(); save(); };
$('btnDeletePlaylist').onclick = () => { if (state.playlists.length <= 1) return; state.playlists.splice(state.activePlaylist, 1); state.activePlaylist = 0; state.activeIndex = 0; renderLists(); showImage(); save(); };
$('btnRemoveImage').onclick = () => { const idx = parseInt(els.imageList.value); if (Number.isNaN(idx)) return; currentPlaylist().images.splice(idx, 1); state.activeIndex = Math.min(state.activeIndex, Math.max(0, currentPlaylist().images.length - 1)); renderLists(); showImage(); save(); };
$('btnClearImages').onclick = () => { currentPlaylist().images = []; state.activeIndex = 0; renderLists(); showImage(); save(); };
els.playlistSelect.onchange = () => { state.activePlaylist = parseInt(els.playlistSelect.value); state.activeIndex = 0; stopTimer(); showImage(); save(); };
els.imageList.ondblclick = () => { const idx = parseInt(els.imageList.value); if (!Number.isNaN(idx)) { state.activeIndex = idx; showImage(); } };
document.querySelectorAll('.presetRow button').forEach(btn => btn.onclick = () => { $('durationInput').value = btn.dataset.time; });

// ---- 흑백/레벨 조정: 클립스튜디오 레벨 보정처럼, 저장을 안 눌러도 슬라이더를 움직이는 즉시 미리보기가 반영된다 ----
// 실제로 state.settings에 반영(다음 실행에도 유지)되는 건 "저장" 버튼(applySettingsFromForm)을 눌렀을 때뿐이다.
function previewLevelsFromForm() {
  $('levelBlackVal').textContent = $('levelBlackInput').value;
  $('levelGammaVal').textContent = ((parseInt($('levelGammaInput').value) || 100) / 100).toFixed(2);
  $('levelWhiteVal').textContent = $('levelWhiteInput').value;
  updateLevelsFilter({
    gray: $('grayscaleCheck').checked,
    black: parseInt($('levelBlackInput').value) || 0,
    gamma: (parseInt($('levelGammaInput').value) || 100) / 100,
    white: parseInt($('levelWhiteInput').value) || 255
  });
}
// 툴바에서 바로 쓰는 패널이라 별도 "저장" 버튼이 없다 - 슬라이더를 놓거나(change) 버튼을 누르면 바로 state에 반영하고 저장한다.
function commitLevelsFromForm() {
  state.settings.levels = {
    gray: $('grayscaleCheck').checked,
    black: parseInt($('levelBlackInput').value) || 0,
    gamma: (parseInt($('levelGammaInput').value) || 100) / 100,
    white: parseInt($('levelWhiteInput').value) || 255
  };
  $('btnGrayToggle').classList.toggle('active', state.settings.levels.gray);
  save();
}
['levelBlackInput', 'levelGammaInput', 'levelWhiteInput'].forEach(id => {
  $(id).addEventListener('input', previewLevelsFromForm); // 드래그하는 동안 실시간 미리보기
  $(id).addEventListener('change', commitLevelsFromForm); // 손을 뗀 시점에 저장
});
$('btnResetLevels').onclick = () => {
  $('levelBlackInput').value = 0;
  $('levelGammaInput').value = 100;
  $('levelWhiteInput').value = 255;
  previewLevelsFromForm();
  commitLevelsFromForm();
};
$('btnGrayToggle').onclick = () => {
  $('grayscaleCheck').checked = !$('grayscaleCheck').checked;
  previewLevelsFromForm();
  commitLevelsFromForm();
};
$('btnLevelsPanel').onclick = (e) => { e.stopPropagation(); $('levelsPanel').classList.toggle('show'); };
// 레벨 패널이 열려 있을 때 패널/여는버튼이 아닌 곳을 클릭하면 자동으로 닫는다
document.addEventListener('click', (e) => {
  const panel = $('levelsPanel');
  if (!panel.classList.contains('show')) return;
  if (panel.contains(e.target) || e.target === $('btnLevelsPanel')) return;
  panel.classList.remove('show');
});
// 설정창이 닫히면(저장했든, Esc로 취소했든) 실제 state.settings에 반영된 값으로 필터를 다시 맞춘다.
els.settingsDialog.addEventListener('close', () => updateLevelsFilter());

// ---- 동영상 전용 컨트롤: 프레임 이동 / 재생-정지 / 탐색바 / 재생속도 ----
function updateVideoUI() {
  const v = els.videoView;
  const dur = v.duration || 0;
  const cur = v.currentTime || 0;
  els.videoSeek.value = dur ? (cur / dur * 100) : 0;
  els.videoTime.textContent = `${fmt(Math.floor(cur))} / ${fmt(Math.floor(dur))}`;
  els.btnVideoPlay.textContent = v.paused ? '▶' : '⏸';
  // 화면 중앙의 큰 재생 버튼 - 일시정지 중엔 ▶(재생), 재생 중엔 ⏸(일시정지) 아이콘으로 바뀐다.
  // 재생 중에도 옅게 계속 보이고 눌려야 다시 멈출 수 있어서, 안 보이게 숨기지 않는다(위 CSS 참고).
  els.centerPlayIcon.textContent = v.paused ? '▶' : '⏸';
  els.centerPlayIcon.classList.toggle('iconPlay', v.paused);
  els.centerPlayBtn.classList.toggle('paused', v.paused);
}
els.videoView.addEventListener('loadedmetadata', updateVideoUI);
els.videoView.addEventListener('timeupdate', updateVideoUI);
els.videoView.addEventListener('play', updateVideoUI);
els.videoView.addEventListener('pause', updateVideoUI);
els.btnVideoPlay.onclick = () => { els.videoView.paused ? els.videoView.play() : els.videoView.pause(); };
els.centerPlayBtn.onclick = () => { els.videoView.paused ? els.videoView.play() : els.videoView.pause(); };
els.btnFramePrev.onclick = () => { els.videoView.pause(); els.videoView.currentTime = Math.max(0, els.videoView.currentTime - FRAME_STEP); };
els.btnFrameNext.onclick = () => { els.videoView.pause(); els.videoView.currentTime = Math.min(els.videoView.duration || 0, els.videoView.currentTime + FRAME_STEP); };
// 탐색바를 드래그하는 동안엔 timeupdate가 되돌리지 않게, input 이벤트로 직접 시간을 옮긴다
els.videoSeek.oninput = () => {
  const dur = els.videoView.duration || 0;
  if (!dur) return;
  els.videoView.currentTime = (els.videoSeek.value / 100) * dur;
};
els.videoSpeedSelect.onchange = () => {
  const speed = parseFloat(els.videoSpeedSelect.value) || 1;
  state.settings.videoSpeed = speed;
  els.videoView.playbackRate = speed;
  save();
};
document.addEventListener('keydown', (e) => {
  if (els.settingsDialog.open) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.key === 'ArrowRight') nextImage(false);
  if (e.key === 'ArrowLeft') prevImage();
  if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.altKey) setRefVisible(!refVisible);
  if (e.key === 'F11') { e.preventDefault(); els.btnFullscreen.click(); }
  if (e.key === 'Escape') window.croquisAPI.exitFullscreen();
  // 좌우반전: 처음엔 F로 뒀다가(2026-07-17), F는 노트북/사무실 환경에서 이미 선점돼 있을 가능성이
  // 있다는 이유로 충돌 위험이 적은 Ctrl+Alt+U로 변경(2026-07-17). 다른 연동 앱(그리드, OBJ 배치
  // 뷰어)과 동일한 조합키.
  if (e.ctrlKey && e.altKey && !e.metaKey && (e.key === 'u' || e.key === 'U')) setMirrored(!mirrored);
});

// 2026-07-17: 위성 창(통과 모드/레퍼런스 버튼)도 topBar/bottomBar 등 다른 버튼들과 같은
// 타이밍(그림 위에 마우스가 있을 때)에 나타나도록, 이 창의 hover 상태를 메인 프로세스 경유로
// 전달한다. 위성 창은 별도 BrowserWindow라 이 창의 CSS :hover만으로는 상태를 못 넘긴다.
// 2026-07-22 원인 파악: 앱을 켤 때 이 창이 (레퍼런스 라이브러리에서 클릭한 지점을 중심으로)
// 마우스 커서 바로 아래에 뜨는 경우가 많은데, mouseenter는 "커서가 바깥에서 안으로 들어오는
// 순간"에만 발생하는 이벤트라 처음부터 커서가 안에 있으면 실제로 마우스를 움직여 한 번
// 밖으로 나갔다 들어오기 전까진 절대 발생하지 않는다. 그래서 켜자마자는 위성 창 버튼이
// 안 보이고, 아무 데나 마우스를 한 번 움직여야(그제서야 enter/leave 경계를 넘게 되어) 나타나는
// 것처럼 보였던 것 - 창 렌더링 버그가 아니라 이 이벤트 자체의 특성 때문이었다. mousemove는
// 커서가 이미 안에 있어도 조금만 움직이면 바로 발생하므로, 로드 후 첫 mousemove 한 번만으로도
// hover 상태를 켜준다(그 다음부터는 mouseenter/mouseleave가 정상적으로 이어받는다).
// 2026-07-27: topBar/bottomBar 등 메뉴는 원래 CSS :hover로만 보임/숨김을 결정했는데,
// #app 전체가 -webkit-app-region:drag라(창 이동용) 드래그 핸들이나 빈 여백을 잡고 창을
// 옮긴 뒤 마우스 버튼을 창 "바깥"에서 놓으면, 그 순간 렌더러는 아무 이벤트도 못 받는다
// (OS가 네이티브 드래그를 처리하는 동안 렌더러의 마우스 이벤트 스트림 자체가 끊기기 때문).
// 그 결과 크로미움 내부의 :hover 판정이 "커서가 계속 창 안에 있다"는 상태로 멈춰버려서,
// 실제로는 커서가 창 밖으로 완전히 나갔는데도 메뉴가 안 사라지는 버그가 생긴다.
// 그래서 :hover 대신 JS로 직접 관리하는 hoverActive 클래스로 바꾸고(mouseenter/leave는
// 그대로 쓰되), 창이 움직임을 멈춘 직후 메인 프로세스가 실제 커서 좌표를 확인해서 보정
// 신호(hover-correct)를 보내주면 그 값으로 강제로 맞춘다. 위성 창(notifyHover)도 같은
// 값을 그대로 같이 보내 동일한 버그를 같이 막는다.
function setHoverActive(v) {
  document.body.classList.toggle('hoverActive', v);
  window.croquisAPI.notifyHover(v);
}
document.body.addEventListener('mousemove', () => setHoverActive(true), { once: true });
document.body.addEventListener('mouseenter', () => setHoverActive(true));
document.body.addEventListener('mouseleave', () => setHoverActive(false));
window.croquisAPI.onHoverCorrect((inside) => setHoverActive(inside));

load();
window.croquisAPI.setAlwaysOnTop(state.settings.alwaysTop);
els.btnPin.classList.toggle('active', state.settings.alwaysTop);
window.croquisAPI.onAddImages(addImagesFromExternal);
showImage(); renderLists(); updateUI();
if (state.settings.autoStart) setTimeout(startTimer, 300);
