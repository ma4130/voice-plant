const ROUND_SECONDS = 10;

const elements = {
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
  voiceTrigger: document.querySelector('#voiceTrigger'),
  voiceKicker: document.querySelector('.voice-copy small'),
  voicePhrase: document.querySelector('.voice-copy strong'),
};

let state = {
  playing: false,
  finished: false,
  micStatus: 'starting',
  growth: 18,
  bestGrowth: 18,
  level: 0,
  timeLeft: ROUND_SECONDS,
};

let audioContext = null;
let stream = null;
let analyser = null;
let animationFrame = null;
let roundTimer = null;
let previousFrame = 0;
let micRequestId = 0;

function stageName(growth) {
  if (growth >= 88) return '満開';
  if (growth >= 60) return 'つぼみ';
  if (growth >= 32) return '若葉';
  return 'めばえ';
}

function growthToMeters(growth) {
  return (growth / 50).toFixed(1);
}

function renderVoiceStatus() {
  const { playing, finished, micStatus } = state;
  elements.voiceTrigger.classList.toggle('active', playing);
  elements.voiceTrigger.classList.toggle('listening', playing);
  elements.voiceTrigger.classList.toggle('error', micStatus === 'denied' || micStatus === 'unsupported');

  if (playing) {
    elements.voiceKicker.textContent = '計測中';
    elements.voicePhrase.textContent = '声の大きさで育てよう';
    elements.hint.textContent = '大きな声ほど、植物がぐんぐん育ちます。';
  } else if (finished) {
    elements.voiceKicker.textContent = '計測終了';
    elements.voicePhrase.textContent = `${growthToMeters(state.bestGrowth)}mまで育ちました`;
    elements.hint.textContent = 'もう一度遊ぶときは「はじめから」を押してください。';
  } else if (micStatus === 'denied') {
    elements.voiceKicker.textContent = 'マイクが使えません';
    elements.voicePhrase.textContent = 'マイクを許可して再読み込み';
    elements.hint.textContent = 'アドレスバー左の設定から、マイクを許可してください。';
  } else if (micStatus === 'unsupported') {
    elements.voiceKicker.textContent = 'マイクに対応していません';
    elements.voicePhrase.textContent = 'Chromeで開いてください';
    elements.hint.textContent = 'マイクを使えるブラウザーで開いてください。';
  } else {
    elements.voiceKicker.textContent = 'マイクを準備中';
    elements.voicePhrase.textContent = '許可すると自動で始まります';
    elements.hint.textContent = 'マイクの使用を許可してください。';
  }
}

function render() {
  const { growth, bestGrowth, level, timeLeft, playing, finished } = state;
  elements.time.textContent = timeLeft;
  elements.score.textContent = growthToMeters(bestGrowth);
  elements.stage.textContent = playing ? stageName(growth) : finished ? 'おしまい' : '準備中';
  elements.liveDot.classList.toggle('active', playing);

  const scale = 0.42 + growth / 172;
  elements.plant.style.setProperty('--scale', scale);
  elements.plant.style.setProperty('--sway', `${level / 33}deg`);
  elements.plant.setAttribute('aria-label', `植物の高さ ${growthToMeters(growth)}m`);
  elements.plant.classList.toggle('bloom-one', growth >= 48);
  elements.plant.classList.toggle('bloom-two', growth >= 68);

  elements.meterFill.style.width = `${level}%`;
  elements.meter.setAttribute('aria-valuenow', Math.round(level));
  elements.rings.style.opacity = playing ? Math.min(.82, .08 + level / 115) : 0;
  elements.meterMessage.textContent = playing
    ? level > 55 ? 'いい声！' : level > 12 ? 'その調子！' : '声の大きさ'
    : finished ? '今回の記録' : 'マイクを準備中';

  const bloomCount = Math.min(5, Math.max(1, Math.ceil(bestGrowth / 20)));
  [...elements.flowerCount.children].forEach((flower, index) => flower.classList.toggle('active', index < bloomCount));
  elements.flowerCount.setAttribute('aria-label', `集めた花 ${bloomCount}個`);
  renderVoiceStatus();
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

async function startMicrophone() {
  const requestId = ++micRequestId;
  state.micStatus = 'requesting';
  render();
  try {
    const requestedStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    if (requestId !== micRequestId) {
      requestedStream.getTracks().forEach((track) => track.stop());
      return false;
    }
    stream = requestedStream;
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = .72;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    state.micStatus = 'active';
    return true;
  } catch {
    if (requestId !== micRequestId) return false;
    state.playing = false;
    state.micStatus = navigator.mediaDevices ? 'denied' : 'unsupported';
    render();
    return false;
  }
}

async function startRound() {
  micRequestId += 1;
  clearInterval(roundTimer);
  stopAudio();
  state = {
    playing: false,
    finished: false,
    micStatus: 'starting',
    growth: 18,
    bestGrowth: 18,
    level: 0,
    timeLeft: ROUND_SECONDS,
  };
  render();
  const microphoneReady = await startMicrophone();
  if (!microphoneReady) return;

  state.playing = true;
  previousFrame = performance.now();
  animationFrame = requestAnimationFrame(readMicrophone);
  render();
  roundTimer = setInterval(() => {
    state.timeLeft -= 1;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      finishRound();
    } else {
      render();
    }
  }, 1000);
}

function finishRound() {
  micRequestId += 1;
  state.playing = false;
  state.finished = true;
  clearInterval(roundTimer);
  stopAudio();
  render();
}

elements.reset.addEventListener('click', startRound);
window.addEventListener('pagehide', () => {
  micRequestId += 1;
  clearInterval(roundTimer);
  stopAudio();
});

render();
startRound();

