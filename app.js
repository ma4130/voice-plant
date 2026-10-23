const ROUND_SECONDS = 30;

const elements = {
  start: document.querySelector('#startButton'),
  reset: document.querySelector('#resetButton'),
  time: document.querySelector('#timeOutput'),
  score: document.querySelector('#scoreOutput'),
  stage: document.querySelector('#stageOutput'),
  liveDot: document.querySelector('#liveDot'),
  plant: document.querySelector('#plant'),
  meter: document.querySelector('.meter'),
  meterFill: document.querySelector('#meterFill'),
  meterMessage: document.querySelector('#meterMessage'),
  rings: document.querySelector('#soundRings'),
  hint: document.querySelector('#hint'),
  flowerCount: document.querySelector('#flowerCount'),
};

let state = {
  playing: false,
  micStatus: 'idle',
  growth: 18,
  bestGrowth: 18,
  level: 0,
  timeLeft: ROUND_SECONDS,
  holding: false,
};

let audioContext = null;
let stream = null;
let analyser = null;
let animationFrame = null;
let roundTimer = null;
let fallbackTimer = null;
let previousFrame = 0;
let micRequestId = 0;

function stageName(growth) {
  if (growth >= 88) return '満開';
  if (growth >= 60) return 'つぼみ';
  if (growth >= 32) return '若葉';
  return 'めばえ';
}

function render() {
  const { growth, bestGrowth, level, timeLeft, playing, micStatus } = state;
  elements.time.textContent = timeLeft;
  elements.score.textContent = Math.round(bestGrowth);
  elements.stage.textContent = playing ? stageName(growth) : timeLeft === 0 ? 'そだちきった！' : 'おやすみ中';
  elements.liveDot.classList.toggle('active', playing);

  const scale = 0.42 + growth / 172;
  elements.plant.style.setProperty('--scale', scale);
  elements.plant.style.setProperty('--sway', `${level / 33}deg`);
  elements.plant.setAttribute('aria-label', `植物の成長度 ${Math.round(growth)}%`);
  elements.plant.classList.toggle('bloom-one', growth >= 48);
  elements.plant.classList.toggle('bloom-two', growth >= 68);

  elements.meterFill.style.width = `${level}%`;
  elements.meter.setAttribute('aria-valuenow', Math.round(level));
  elements.rings.style.opacity = playing ? Math.min(.82, .08 + level / 115) : 0;
  elements.meterMessage.textContent = level > 55 ? 'いい声！' : level > 12 ? 'その調子！' : '声の大きさ';

  const bloomCount = Math.min(5, Math.max(1, Math.ceil(bestGrowth / 20)));
  [...elements.flowerCount.children].forEach((flower, index) => flower.classList.toggle('active', index < bloomCount));
  elements.flowerCount.setAttribute('aria-label', `集めた花 ${bloomCount}個`);

  const label = elements.start.querySelector('span');
  elements.start.classList.toggle('holding', state.holding);
  elements.start.disabled = micStatus === 'requesting';
  if (!playing) label.textContent = timeLeft === 0 ? 'もう一度' : '声をとどける';
  else if (micStatus === 'requesting') label.textContent = 'マイクを準備中…';
  else if (micStatus === 'denied') label.textContent = state.holding ? 'そのまま！' : '押して育てる';
  else label.textContent = '声を聞いています';

  if (!playing) elements.hint.textContent = 'ボタンを押してマイクを許可してください。';
  else if (micStatus === 'denied') elements.hint.textContent = 'マイクなしモード：ボタンを押し続けると育ちます。';
  else elements.hint.textContent = '長く声を出すと、植物がぐんぐん育ちます。';
}

function stopAudio() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  stream?.getTracks().forEach((track) => track.stop());
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  animationFrame = null;
  stream = null;
  audioContext = null;
  analyser = null;
  state.level = 0;
}

function finishRound() {
  micRequestId += 1;
  state.playing = false;
  state.holding = false;
  clearInterval(roundTimer);
  clearInterval(fallbackTimer);
  stopAudio();
  state.micStatus = state.micStatus === 'denied' ? 'denied' : 'idle';
  render();
}

function readMicrophone(timestamp) {
  if (!analyser || !state.playing) return;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / samples.length);
  const rawLevel = Math.min(100, Math.max(0, (rms - .018) * 520));
  state.level = state.level * .68 + rawLevel * .32;
  const delta = Math.min(.05, Math.max(0, (timestamp - previousFrame) / 1000));
  previousFrame = timestamp;
  const change = rawLevel > 8 ? rawLevel / 100 * 18 * delta : -3.2 * delta;
  state.growth = Math.min(100, Math.max(8, state.growth + change));
  state.bestGrowth = Math.max(state.bestGrowth, state.growth);
  render();
  animationFrame = requestAnimationFrame(readMicrophone);
}

function startFallback() {
  clearInterval(fallbackTimer);
  fallbackTimer = setInterval(() => {
    if (!state.playing) return;
    const change = state.holding ? 1.35 : -.24;
    state.growth = Math.min(100, Math.max(8, state.growth + change));
    state.bestGrowth = Math.max(state.bestGrowth, state.growth);
    state.level = state.holding ? 72 : 0;
    render();
  }, 90);
}

async function startMicrophone() {
  const requestId = ++micRequestId;
  state.micStatus = 'requesting';
  render();
  try {
    const requestedStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    if (requestId !== micRequestId || !state.playing) {
      requestedStream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = requestedStream;
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = .72;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    state.micStatus = 'active';
    previousFrame = performance.now();
    animationFrame = requestAnimationFrame(readMicrophone);
  } catch {
    if (requestId !== micRequestId || !state.playing) return;
    state.micStatus = 'denied';
    startFallback();
  }
  render();
}

function startRound() {
  stopAudio();
  clearInterval(roundTimer);
  clearInterval(fallbackTimer);
  state = { playing: true, micStatus: 'idle', growth: 18, bestGrowth: 18, level: 0, timeLeft: ROUND_SECONDS, holding: false };
  render();
  startMicrophone();
  roundTimer = setInterval(() => {
    state.timeLeft -= 1;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      finishRound();
    } else render();
  }, 1000);
}

function resetGame() {
  micRequestId += 1;
  clearInterval(roundTimer);
  clearInterval(fallbackTimer);
  stopAudio();
  state = { playing: false, micStatus: 'idle', growth: 18, bestGrowth: 18, level: 0, timeLeft: ROUND_SECONDS, holding: false };
  render();
}

function setHolding(value) {
  if (!state.playing || state.micStatus !== 'denied') return;
  state.holding = value;
  render();
}

elements.start.addEventListener('click', () => {
  if (!state.playing) startRound();
});
elements.start.addEventListener('pointerdown', () => setHolding(true));
elements.start.addEventListener('pointerup', () => setHolding(false));
elements.start.addEventListener('pointerleave', () => setHolding(false));
elements.start.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && state.micStatus === 'denied') { event.preventDefault(); setHolding(true); }
});
elements.start.addEventListener('keyup', (event) => {
  if (event.code === 'Space') setHolding(false);
});
elements.reset.addEventListener('click', resetGame);
window.addEventListener('pagehide', stopAudio);

render();

