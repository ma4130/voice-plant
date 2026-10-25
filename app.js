const ROUND_SECONDS = 10;
const WAKE_WORD = 'そだって';

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
  micStatus: 'idle',
  keywordStatus: 'starting',
  growth: 18,
  bestGrowth: 18,
  level: 0,
  timeLeft: ROUND_SECONDS,
  lastHeard: '',
};

let audioContext = null;
let stream = null;
let analyser = null;
let animationFrame = null;
let roundTimer = null;
let previousFrame = 0;
let micRequestId = 0;
let recognition = null;
let recognitionActive = false;
let recognitionRestartTimer = null;
let shouldListen = true;

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
  const { playing, keywordStatus } = state;
  elements.voiceTrigger.classList.toggle('active', playing);
  elements.voiceTrigger.classList.toggle('listening', !playing && keywordStatus === 'listening');
  elements.voiceTrigger.classList.toggle('error', keywordStatus === 'denied' || keywordStatus === 'unsupported');

  if (playing) {
    elements.voiceKicker.textContent = 'ゲーム中';
    elements.voicePhrase.textContent = '声で大きく育てよう';
    elements.hint.textContent = '長く声を出すと、植物がぐんぐん育ちます。';
    return;
  }
  if (keywordStatus === 'listening') {
    elements.voiceKicker.textContent = '合言葉を言ってね';
    elements.voicePhrase.textContent = '「そだって」';
    elements.hint.textContent = state.lastHeard
      ? `「${state.lastHeard}」と聞こえました。合言葉は「そだって」です。`
      : 'マイクが合言葉を待っています。';
  } else if (keywordStatus === 'denied') {
    elements.voiceKicker.textContent = 'マイクが使えません';
    elements.voicePhrase.textContent = 'マイクを許可して再読み込み';
    elements.hint.textContent = 'アドレスバー左の設定から、マイクを許可してください。';
  } else if (keywordStatus === 'unsupported') {
    elements.voiceKicker.textContent = '音声の聞き取りに非対応です';
    elements.voicePhrase.textContent = 'Chromeで開いてください';
    elements.hint.textContent = 'この機能はGoogle Chromeの音声認識を使います。';
  } else {
    elements.voiceKicker.textContent = 'マイクを準備中';
    elements.voicePhrase.textContent = 'すこし待ってね';
    elements.hint.textContent = 'マイクを許可すると、自動で合言葉を待ちます。';
  }
}

function render() {
  const { growth, bestGrowth, level, timeLeft, playing, keywordStatus } = state;
  elements.time.textContent = timeLeft;
  elements.score.textContent = growthToMeters(bestGrowth);
  elements.stage.textContent = playing ? stageName(growth) : keywordStatus === 'listening' ? 'ことば待ち' : '準備中';
  elements.liveDot.classList.toggle('active', playing || keywordStatus === 'listening');

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
    : keywordStatus === 'listening' ? '合言葉を聞いています' : 'マイクを準備中';

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

function stopKeywordListening(permanent = false) {
  clearTimeout(recognitionRestartTimer);
  if (permanent) shouldListen = false;
  if (recognitionActive) {
    try { recognition.stop(); } catch { /* already stopping */ }
  }
  recognitionActive = false;
}

function scheduleKeywordRestart(delay = 650) {
  clearTimeout(recognitionRestartTimer);
  if (!shouldListen || state.playing) return;
  recognitionRestartTimer = setTimeout(startKeywordListening, delay);
}

function createRecognition() {
  if (recognition) return recognition;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;
  recognition = new Recognition();
  recognition.lang = 'ja-JP';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    recognitionActive = true;
    if (!state.playing) {
      state.keywordStatus = 'listening';
      render();
    }
  };
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript.replace(/\s/g, '');
      if (!transcript) continue;
      state.lastHeard = transcript;
      render();
      if (transcript.includes(WAKE_WORD) || transcript.includes('育って')) {
        startRound();
        break;
      }
    }
  };
  recognition.onerror = (event) => {
    recognitionActive = false;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      shouldListen = false;
      state.keywordStatus = 'denied';
      render();
      return;
    }
    if (!state.playing) {
      state.keywordStatus = 'starting';
      render();
      scheduleKeywordRestart(900);
    }
  };
  recognition.onend = () => {
    recognitionActive = false;
    scheduleKeywordRestart();
  };
  return recognition;
}

function startKeywordListening() {
  if (state.playing || recognitionActive) return;
  shouldListen = true;
  const keywordRecognition = createRecognition();
  if (!keywordRecognition) {
    state.keywordStatus = 'unsupported';
    shouldListen = false;
    render();
    return;
  }
  state.keywordStatus = 'starting';
  render();
  try {
    keywordRecognition.start();
  } catch {
    scheduleKeywordRestart(900);
  }
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
    if (requestId !== micRequestId || !state.playing) {
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
    previousFrame = performance.now();
    animationFrame = requestAnimationFrame(readMicrophone);
    return true;
  } catch {
    if (requestId !== micRequestId) return false;
    state.playing = false;
    state.micStatus = 'denied';
    state.keywordStatus = 'denied';
    shouldListen = false;
    render();
    return false;
  }
}

async function startRound() {
  if (state.playing) return;
  clearInterval(roundTimer);
  stopAudio();
  state = { playing: true, micStatus: 'idle', keywordStatus: 'paused', growth: 18, bestGrowth: 18, level: 0, timeLeft: ROUND_SECONDS, lastHeard: WAKE_WORD };
  stopKeywordListening(true);
  render();
  const microphoneReady = await startMicrophone();
  if (!microphoneReady) return;
  roundTimer = setInterval(() => {
    state.timeLeft -= 1;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      finishRound();
    } else render();
  }, 1000);
}

function finishRound() {
  micRequestId += 1;
  state.playing = false;
  state.keywordStatus = 'starting';
  state.lastHeard = '';
  clearInterval(roundTimer);
  stopAudio();
  render();
  shouldListen = true;
  scheduleKeywordRestart(900);
}

function resetGame() {
  micRequestId += 1;
  clearInterval(roundTimer);
  stopAudio();
  stopKeywordListening();
  state = { playing: false, micStatus: 'idle', keywordStatus: 'starting', growth: 18, bestGrowth: 18, level: 0, timeLeft: ROUND_SECONDS, lastHeard: '' };
  shouldListen = true;
  render();
  scheduleKeywordRestart(350);
}

elements.reset.addEventListener('click', resetGame);
window.addEventListener('pagehide', () => {
  shouldListen = false;
  stopKeywordListening(true);
  stopAudio();
});

render();
startKeywordListening();

