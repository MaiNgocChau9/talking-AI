// app.js
import { GoogleGenAI, Modality } from '@google/genai';
import { createBlobFromFloat32, decode, decodeAudioPCMToBuffer } from './utils.js';

const $ = (sel) => document.querySelector(sel);

const statusEl = $('#status');
const micBtn = $('#micBtn');
const closeBtn = $('#closeBtn');
const settingsBtn = $('#settingsBtn');
const vizCanvas = $('#viz');
const vizCtx = vizCanvas.getContext('2d');

let isRecording = false;
let client = null;
let session = null;

const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
const inputCtx = new AudioContextCtor({ sampleRate: 16000 });
const outputCtx = new AudioContextCtor({ sampleRate: 24000 });

const inputGain = inputCtx.createGain();
const outputGain = outputCtx.createGain();
outputGain.connect(outputCtx.destination);

// Analyser nodes for visualizer
const inputAnalyser = inputCtx.createAnalyser();
const outputAnalyser = outputCtx.createAnalyser();
inputAnalyser.fftSize = 32;
outputAnalyser.fftSize = 32;

let mediaStream = null;
let sourceNode = null;
let scriptProcessorNode = null;

let nextStartTime = 0;
const playingSources = new Set();

// UI helpers
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}
function setError(msg) {
  setStatus(msg, true);
}
function updateButtons() {
  closeBtn.disabled = isRecording || !session;
  micBtn.setAttribute('aria-label', isRecording ? 'Stop recording' : 'Start recording');
}

// API key helpers
function getApiKey() {
  return (
    window.GEMINI_API_KEY || // optional global
    localStorage.getItem('GEMINI_API_KEY') ||
    ''
  );
}
function ensureApiKey() {
  let key = getApiKey();
  if (!key) {
    key = prompt('Nhập Gemini API Key:', '');
    if (key) localStorage.setItem('GEMINI_API_KEY', key);
  }
  return key;
}

// Client/session setup
async function initClient() {
  const apiKey = ensureApiKey();
  if (!apiKey) {
    setError('Thiếu API key. Nhấn "settings" để nhập.');
    return;
  }
  client = new GoogleGenAI({ apiKey });
  await initSession();
}

async function initSession() {
  if (!client) return;
  const model = 'gemini-2.5-flash-preview-native-audio-dialog';

  try {
    session = await client.live.connect({
      model,
      callbacks: {
        onopen: () => {
          setStatus('Đã kết nối');
          setTimeout(() => {
            if (!isRecording) setStatus('Nhấn mic để nói');
          }, 800);
          updateButtons();
        },
        onmessage: async (message) => {
          try {
            const content = message?.serverContent;
            const parts = content?.modelTurn?.parts || [];

            // Find any inlineData audio chunk
            for (const part of parts) {
              const inline = part?.inlineData;
              if (inline?.data) {
                // Schedule decoded audio buffer
                nextStartTime = Math.max(nextStartTime, outputCtx.currentTime);
                const buffer = await decodeAudioPCMToBuffer(
                  decode(inline.data),
                  outputCtx,
                  24000,
                  1
                );
                const src = outputCtx.createBufferSource();
                src.buffer = buffer;
                src.connect(outputGain);
                // Also feed analyser
                outputGain.connect(outputAnalyser);

                src.addEventListener('ended', () => {
                  playingSources.delete(src);
                });

                src.start(nextStartTime);
                nextStartTime += buffer.duration;
                playingSources.add(src);
              }
            }

            // Handle interruptions
            if (content?.interrupted) {
              for (const s of Array.from(playingSources)) {
                try { s.stop(); } catch {}
                playingSources.delete(s);
              }
              nextStartTime = 0;
            }
          } catch (e) {
            console.error(e);
            setError(`Lỗi xử lý âm thanh: ${e.message || e}`);
          }
        },
        onerror: (e) => {
          console.error('Live error:', e);
          setError((e && e.message) || 'Lỗi kết nối');
        },
        onclose: () => {
          setStatus('Kết nối đã đóng.');
          updateButtons();
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Orus' },
          },
        },
      },
    });
    updateButtons();
  } catch (e) {
    console.error(e);
    setError(e.message || String(e));
  }
}

// Recording
async function startRecording() {
  if (isRecording) return;
  try {
    await inputCtx.resume();
    setStatus('Tôi đang lắng nghe...');
    const constraints = { audio: true, video: false };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

    sourceNode = inputCtx.createMediaStreamSource(mediaStream);

    // route for analysis
    sourceNode.connect(inputGain);
    inputGain.connect(inputAnalyser);

    // script processor for capturing PCM
    const bufferSize = 256;
    scriptProcessorNode = inputCtx.createScriptProcessor(bufferSize, 1, 1);
    // feed processor (don't send to speakers; processor outputs silence)
    sourceNode.connect(scriptProcessorNode);
    scriptProcessorNode.connect(inputCtx.destination);

    scriptProcessorNode.onaudioprocess = (event) => {
      if (!isRecording || !session) return;
      const inputBuffer = event.inputBuffer;
      const pcmFloat = inputBuffer.getChannelData(0);
      // Send PCM as base64 Int16
      session.sendRealtimeInput({ media: createBlobFromFloat32(pcmFloat) });
    };

    isRecording = true;
    updateButtons();
  } catch (err) {
    console.error('Error starting recording:', err);
    setError(`Lỗi micro: ${err.message || err}`);
    stopRecording();
  }
}

function stopRecording() {
  if (!isRecording && !mediaStream && !inputCtx) return;
  setStatus('Nhấn mic để nói');
  isRecording = false;

  try {
    if (scriptProcessorNode) {
      scriptProcessorNode.disconnect();
    }
    if (sourceNode) {
      sourceNode.disconnect();
    }
  } catch {}

  scriptProcessorNode = null;
  sourceNode = null;

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  updateButtons();
}

async function resetSession() {
  stopRecording();
  try {
    session?.close();
  } catch {}
  nextStartTime = 0;
  for (const src of Array.from(playingSources)) {
    try { src.stop(); } catch {}
    playingSources.delete(src);
  }
  await initSession();
  setStatus('Phiên mới đã bắt đầu.');
}

// Visualizer
function drawVisualizer() {
  const WIDTH = vizCanvas.width;
  const HEIGHT = vizCanvas.height;

  // Background
  vizCtx.clearRect(0, 0, WIDTH, HEIGHT);
  vizCtx.fillStyle = '#1f2937';
  vizCtx.fillRect(0, 0, WIDTH, HEIGHT);

  // Get data
  const inputData = new Uint8Array(inputAnalyser.frequencyBinCount);
  const outputData = new Uint8Array(outputAnalyser.frequencyBinCount);
  inputAnalyser.getByteFrequencyData(inputData);
  outputAnalyser.getByteFrequencyData(outputData);

  const barCount = Math.max(inputData.length, outputData.length);
  const barWidth = WIDTH / barCount;

  // Input gradient
  const inGrad = vizCtx.createLinearGradient(0, 0, 0, HEIGHT);
  inGrad.addColorStop(1, '#D16BA5');
  inGrad.addColorStop(0.5, '#E78686');
  inGrad.addColorStop(0, '#FB5F5F');
  vizCtx.fillStyle = inGrad;
  for (let i = 0; i < inputData.length; i++) {
    const barH = inputData[i] * (HEIGHT / 255);
    vizCtx.fillRect(i * barWidth, HEIGHT - barH, barWidth - 1, barH);
  }

  // Output gradient (lighter blend)
  vizCtx.globalCompositeOperation = 'lighter';
  const outGrad = vizCtx.createLinearGradient(0, 0, 0, HEIGHT);
  outGrad.addColorStop(1, '#3b82f6');
  outGrad.addColorStop(0.5, '#10b981');
  outGrad.addColorStop(0, '#ef4444');
  vizCtx.fillStyle = outGrad;
  for (let i = 0; i < outputData.length; i++) {
    const barH = outputData[i] * (HEIGHT / 255);
    vizCtx.fillRect(i * barWidth, HEIGHT - barH, barWidth - 1, barH);
  }

  vizCtx.globalCompositeOperation = 'source-over';
  requestAnimationFrame(drawVisualizer);
}

// Events
micBtn.addEventListener('click', async () => {
  if (!session) {
    await initClient();
    if (!session) return; // still no session
  }
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

closeBtn.addEventListener('click', () => {
  resetSession();
});

settingsBtn.addEventListener('click', async () => {
  const current = getApiKey();
  const next = prompt('Nhập hoặc thay đổi Gemini API Key:', current);
  if (next != null) {
    if (next.trim()) {
      localStorage.setItem('GEMINI_API_KEY', next.trim());
      setStatus('Đã lưu API key.');
      // Reconnect if needed
      if (session) {
        await resetSession();
      } else {
        await initClient();
      }
    } else {
      localStorage.removeItem('GEMINI_API_KEY');
      setError('Đã xóa API key. Nhấn "settings" để nhập.');
    }
  }
});

// Start
setStatus('Nhấn mic để nói');
updateButtons();
drawVisualizer();
// Optionally auto-connect if key exists
if (getApiKey()) {
  initClient();
}