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
    
    // DOM elements
    this.statusEl = document.getElementById('status');
    this.micBtn = document.getElementById('micBtn');
    this.resetBtn = document.getElementById('resetBtn');
    
    // Event listeners
    this.micBtn.addEventListener('click', () => this.toggleRecording());
    this.resetBtn.addEventListener('click', () => this.reset());
    
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
              source.addEventListener('ended', () => {
                this.sources.delete(source);
              });
              
              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }
            
            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
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
    
    await this.inputAudioContext.resume();
    this.updateStatus('Tôi đang lắng nghe...');
    
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });
      
      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.inputNode);
      
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
      this.resetBtn.disabled = true;
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
    this.resetBtn.disabled = false;
    
    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }
    
    this.scriptProcessorNode = null;
    this.sourceNode = null;
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
  }
  
  reset() {
    this.stopRecording();
    if (this.session) {
      this.session.close();
    }
    this.initSession();
    this.updateStatus('Phiên mới đã bắt đầu.');
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new LiveAudioApp();
});