import { GoogleGenAI } from 'https://esm.sh/@google/genai@^0.9.0';
import { createBlob, decodeAudioData, decode } from './utils.js';

class LiveAudioApp {
  constructor() {
    this.isRecording = false;
    this.status = 'Nhấn mic để nói';
    this.error = '';
    
    // Audio contexts
    this.inputAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    this.outputAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    this.inputNode = this.inputAudioContext.createGain();
    this.outputNode = this.outputAudioContext.createGain();
    this.nextStartTime = 0;
    this.sources = new Set();
    
    // Audio visualization
    this.analyser = null;
    this.animationId = null;
    
    // DOM elements
    this.statusEl = document.getElementById('status');
    this.micBtn = document.getElementById('micButton');
    this.exitBtn = document.getElementById('exitBtn');
    this.voiceCircle = document.querySelector('.voice-circle');
    
    // Event listeners
    this.micBtn.addEventListener('click', () => this.toggleRecording());
    this.exitBtn.addEventListener('click', () => this.exit());
    
    this.initClient();
  }
  
  initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }
  
  async initClient() {
    this.initAudio();
    
    // Get API key from environment or prompt
    const apiKey = "AIzaSyCOECCL9PByfFOyOgs935lOWtpKM4-4j-A" || prompt('Enter your Gemini API key:');
    
    if (!apiKey) {
      this.updateError('API key is required');
      return;
    }
    
    this.client = new GoogleGenAI({ apiKey });
    this.outputNode.connect(this.outputAudioContext.destination);
    this.initSession();
  }
  
  async initSession() {
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';
    
    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Đã kết nối');
            setTimeout(() => {
              if (!this.isRecording) this.updateStatus('Nhấn mic để nói');
            }, 1000);
          },
          onmessage: async (message) => {
            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData;
            
            if (audio) {
              this.updateStatus('AI đang phản hồi...');
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime
              );
              
              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1
              );
              
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              
              // Connect to analyser for visualization
              if (!this.outputAnalyser) {
                this.outputAnalyser = this.outputAudioContext.createAnalyser();
                this.outputAnalyser.fftSize = 256;
                this.outputNode.connect(this.outputAnalyser);
              }
              
              source.addEventListener('ended', () => {
                this.sources.delete(source);
                if (this.sources.size === 0 && !this.isRecording) {
                  this.updateStatus('Nhấn mic để nói');
                  this.stopVisualization();
                }
              });
              
              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
              
              // Start visualization for output
              this.startOutputVisualization();
            }
            
            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
              this.stopVisualization();
            }
          },
          onerror: (e) => {
            this.updateError(e.message);
          },
          onclose: (e) => {
            this.updateStatus('Kết nối đã đóng.');
          }
        },
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Orus' } }
          }
        }
      });
    } catch (e) {
      console.error(e);
      this.updateError(e.message);
    }
  }
  
  updateStatus(msg) {
    this.status = msg;
    this.error = '';
    this.statusEl.textContent = msg;
    this.statusEl.classList.remove('error');
  }
  
  updateError(msg) {
    this.error = msg;
    this.statusEl.textContent = msg;
    this.statusEl.classList.add('error');
  }
  
  async toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }
  
  async startRecording() {
    if (this.isRecording) return;
    
    // Stop any playing audio
    for (const source of this.sources.values()) {
      source.stop();
      this.sources.delete(source);
    }
    this.nextStartTime = 0;
    
    await this.inputAudioContext.resume();
    this.updateStatus('Tôi đang lắng nghe...');
    
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });
      
      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.inputNode);
      
      // Create analyser for visualization
      this.analyser = this.inputAudioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.sourceNode.connect(this.analyser);
      
      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(bufferSize, 1, 1);
      
      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;
        
        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        
        if (this.session) {
          this.session.sendRealtimeInput({ media: createBlob(pcmData) });
        }
      };
      
      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);
      
      this.isRecording = true;
      this.exitBtn.disabled = true;
      this.micBtn.classList.add('muted');
      this.micBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
      this.voiceCircle.classList.add('listening');
      
      // Start visualization
      this.startVisualization();
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateError(`Lỗi micro: ${err.message}`);
      this.stopRecording();
    }
  }
  
  stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext) return;
    
    this.updateStatus('Nhấn mic để nói');
    this.isRecording = false;
    this.exitBtn.disabled = false;
    this.micBtn.classList.remove('muted');
    this.micBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    this.voiceCircle.classList.remove('listening');
    
    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }
    
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    
    this.scriptProcessorNode = null;
    this.sourceNode = null;
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    
    this.stopVisualization();
  }
  
  startVisualization() {
    if (!this.analyser) return;
    
    const updateCircleSize = () => {
      if (!this.isRecording || !this.analyser) {
        this.stopVisualization();
        return;
      }
      
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(dataArray);
      
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      const scale = Math.min(1 + average / 100, 1.5);
      
      this.voiceCircle.style.transform = `scale(${scale})`;
      this.animationId = requestAnimationFrame(updateCircleSize);
    };
    
    updateCircleSize();
  }
  
  startOutputVisualization() {
    if (!this.outputAnalyser) return;
    
    const updateCircleSize = () => {
      if (!this.outputAnalyser || this.sources.size === 0) {
        this.stopVisualization();
        return;
      }
      
      const dataArray = new Uint8Array(this.outputAnalyser.frequencyBinCount);
      this.outputAnalyser.getByteFrequencyData(dataArray);
      
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      const scale = Math.min(1 + average / 80, 1.3);
      
      this.voiceCircle.style.transform = `scale(${scale})`;
      this.animationId = requestAnimationFrame(updateCircleSize);
    };
    
    updateCircleSize();
  }
  
  stopVisualization() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.voiceCircle.style.transform = 'scale(1)';
  }
  
  exit() {
    this.stopRecording();
    if (this.session) {
      this.session.close();
    }
    // Try to close the window, or redirect if that fails
    if (window.close) {
      window.close();
    } else {
      window.location.href = 'about:blank';
    }
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new LiveAudioApp();
});