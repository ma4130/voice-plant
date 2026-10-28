const ROUND_SECONDS = 10;
const RESULT_SECONDS = 5;
const START_WORD = 'スタート';

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
  micStatus: 'idle',
  speechStatus: 'starting',
  growth: 18,
  bestGrowth: 18,
  level: 0,
  timeLeft: ROUND_SECONDS,
  returnIn: RESULT_SECONDS,
  lastHeard: '',
};

let audioContext = null;
let stream = null;
let analyser = null;
let animationFrame = null;
let roundTimer = null;
let returnTimer = null;
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
  const { playing, finished, speechStatus } = state;
  elements.voiceTrigger.classList.toggle('active', playing || finished);
  elements.voiceTrigger.classList.toggle('listening', !playing && !finished && speechStatus === 'listening');
  elements.voiceTrigger.classList.toggle('error', speechStatus === 'denied' || speechStatus === 'unsupported');

  if (playing) {
    elements.voiceKicker.textContent = '計測中';
    elements.voicePhrase.textContent = '声の大きさで育てよう';
    elements.hint.textContent = '大きな声ほど、植物がぐんぐん育ちます。';
  } else if (finished) {
    elements.voiceKicker.textContent = '計測終了';
    elements.voicePhrase.textContent = `${growthToMeters(state.bestGrowth)}mまで育ちました`;
    elements.hint.textContent = `${state.returnIn}秒後にスタート画面へ戻ります。`;
  } else if (speechStatus === 'listening') {
    elements.voiceKicker.textContent = '声でスタート';
    elements.voicePhrase.textContent = '「スタート」と言ってね';
    elements.hint.textContent = state.lastHeard
      ? `「${state.lastHeard}」と聞こえました。`
      : 'マイクが「スタート」を待っています。';
  } else if (speechStatus === 'denied') {
    elements.voiceKicker.textContent = 'マイクが使えません';
    elements.voicePhrase.textContent = 'マイクを許可して再読み込み';
    elements.hint.textContent = 'アドレスバー左の設定から、マイクを許可してください。';
  } else if (speechStatus === 'unsupported') {
    elements.voiceKicker.textContent = '音声の聞き取りに非対応です';
    elements.voicePhrase.textContent = 'Chromeで開いてください';
    elements.hint.textContent = 'この機能はGoogle Chromeの音声認識を使います。';
  } else {
    elements.voiceKicker.textContent = 'マイクを準備中';
    elements.voicePhrase.textContent = 'すこし待ってね';
    elements.hint.textContent = '準備ができたら「スタート」と言ってください。';
  }
}

function render() {
  const { growth, bestGrowth, level, timeLeft, playing, finished, speechStatus } = state;
  elements.time.textContent = timeLeft;
  elements.score.textContent = growthToMeters(bestGrowth);
  elements.stage.textContent = playing
    ? stageName(growth)
    : finished ? 'おしまい' : speechStatus === 'listening' ? 'スタート待ち' : '準備中';
  elements.liveDot.classList.toggle('active', playing || speechStatus === 'listening');

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
    : finished ? '今回の記録' : speechStatus === 'listening' ? '「スタート」を聞いています' : 'マイクを準備中';

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

function stopListening(permanent = false) {
  clearTimeout(recognitionRestartTimer);
  if (permanent) shouldListen = false;
  if (recognitionActive) {
    try { recognition.stop(); } catch { /* already stopping */ }
  }
  recognitionActive = false;
}

function scheduleRecognitionRestart(delay = 650) {
  clearTimeout(recognitionRestartTimer);
  if (!shouldListen || state.playing || state.finished) return;
  recognitionRestartTimer = setTimeout(startListening, delay);
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
    if (!state.playing && !state.finished) {
      state.speechStatus = 'listening';
      render();
    }
  };

  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript.replace(/\s/g, '');
      if (!transcript) continue;
      state.lastHeard = transcript;
      render();
      if (transcript.includes(START_WORD) || transcript.toLowerCase().includes('start')) {
        startRound();
        break;
      }
    }
  };

  recognition.onerror = (event) => {
    recognitionActive = false;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      shouldListen = false;
      state.speechStatus = 'denied';
      render();
      return;
    }
    if (!state.playing && !state.finished) {
      state.speechStatus = 'starting';
      render();
      scheduleRecognitionRestart(900);
    }
  };

  recognition.onend = () => {
    recognitionActive = false;
    scheduleRecognitionRestart();
  };

  return recognition;
}

function startListening() {
  if (state.playing || state.finished || recognitionActive) return;
  shouldListen = true;
  const voiceRecognition = createRecognition();
  if (!voiceRecognition) {
    state.speechStatus = 'unsupported';
    shouldListen = false;
    render();
    return;
  }
  state.speechStatus = 'starting';
  render();
  try {
    voiceRecognition.start();
  } catch {
    scheduleRecognitionRestart(900);
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
    return true;
  } catch {
    if (requestId !== micRequestId) return false;
    state.playing = false;
    state.speechStatus = navigator.mediaDevices ? 'denied' : 'unsupported';
    shouldListen = false;
    render();
    return false;
  }
}

async function startRound() {
  if (state.playing || state.finished) return;
  clearInterval(roundTimer);
  clearInterval(returnTimer);
  stopListening(true);
  stopAudio();
  state = {
    playing: true,
    finished: false,
    micStatus: 'idle',
    speechStatus: 'paused',
    growth: 18,
    bestGrowth: 18,
    level: 0,
    timeLeft: ROUND_SECONDS,
    returnIn: RESULT_SECONDS,
    lastHeard: START_WORD,
  };
  render();
  const microphoneReady = await startMicrophone();
  if (!microphoneReady) return;

  previousFrame = performance.now();
  animationFrame = requestAnimationFrame(readMicrophone);
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

  clearInterval(returnTimer);
  returnTimer = setInterval(() => {
    state.returnIn -= 1;
    if (state.returnIn <= 0) {
      resetToStart();
    } else {
      render();
    }
  }, 1000);
}

function resetToStart() {
  micRequestId += 1;
  clearInterval(roundTimer);
  clearInterval(returnTimer);
  stopAudio();
  stopListening();
  state = {
    playing: false,
    finished: false,
    micStatus: 'idle',
    speechStatus: 'starting',
    growth: 18,
    bestGrowth: 18,
    level: 0,
    timeLeft: ROUND_SECONDS,
    returnIn: RESULT_SECONDS,
    lastHeard: '',
  };
  shouldListen = true;
  render();
  scheduleRecognitionRestart(350);
}

elements.reset.addEventListener('click', resetToStart);
window.addEventListener('pagehide', () => {
  micRequestId += 1;
  clearInterval(roundTimer);
  clearInterval(returnTimer);
  stopListening(true);
  stopAudio();
});

render();
startListening();

