/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Nhấn mic để nói';
  @state() error = '';

  private client: GoogleGenAI;
  private session: Session;
  // Fix for TS error: 'webkitAudioContext' does not exist on type 'Window'.
  private inputAudioContext = new ((window as any).AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // Fix for TS error: 'webkitAudioContext' does not exist on type 'Window'.
  private outputAudioContext = new ((window as any).AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  private inputNode = this.inputAudioContext.createGain();
  private outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    :host {
      --md-sys-color-primary: #89b3ff;
      --md-sys-color-on-primary: #ffffff;
      --md-sys-color-surface-container-highest: rgba(255, 255, 255, 0.1);
      --md-sys-color-outline-variant: rgba(255, 255, 255, 0.2);
      --md-sys-color-scrim: #000000;
      --md-sys-color-on-surface: #e0e0e0;
      --md-sys-color-on-surface-variant: rgba(255, 255, 255, 0.4);
      --md-sys-color-error: #ff8989;

      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      width: 100vw;
      box-sizing: border-box;
      padding: 16px;
      overflow: hidden;
      position: relative;
    }

    #status {
      flex-grow: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--md-sys-color-on-primary);
      font-size: 2rem;
      text-align: center;
      min-height: 24px;
      font-weight: 500;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    }

    .error {
      color: var(--md-sys-color-error);
      font-weight: 500;
    }

    .controls {
      position: fixed;
      bottom: 40px;
      display: flex;
      gap: 8px;
      background-color: rgba(0, 0, 0, 0.3);
      padding: 8px 12px;
      border-radius: 999px;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      align-items: center;
    }

    .control-button {
      background: transparent;
      border: none;
      color: var(--md-sys-color-on-surface);
      cursor: pointer;
      padding: 8px 16px;
      border-radius: 999px;
      font-family: 'Google Sans', sans-serif;
      font-size: 1rem;
      font-weight: 500;
      transition: background-color 0.2s;
      outline: none;
    }

    .control-button:hover:not(:disabled) {
      background-color: var(--md-sys-color-surface-container-highest);
    }
    
    .control-button:disabled {
        color: var(--md-sys-color-on-surface-variant);
        cursor: not-allowed;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private async initSession() {
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
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
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
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Kết nối đã đóng.');
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
          },
        },
      });
    } catch (e) {
      console.error(e);
      this.updateError(e.message);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    await this.inputAudioContext.resume();
    this.updateStatus('Tôi đang lắng nghe...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.session.sendRealtimeInput({media: createBlob(pcmData)});
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateError(`Lỗi micro: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Nhấn mic để nói');
    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  private reset() {
    this.stopRecording();
    this.session?.close();
    this.initSession();
    this.updateStatus('Phiên mới đã bắt đầu.');
  }

  render() {
    return html`
      <div id="status" class=${this.error ? 'error' : ''}>
        ${this.error || this.status}
      </div>

      <div class="controls">
        <button
          class="control-button"
          @click=${this.reset}
          ?disabled=${this.isRecording}
          aria-label="Close Session"
        >
          close
        </button>
        <button
          class="control-button"
          @click=${this.toggleRecording}
          aria-label=${this.isRecording ? 'Stop recording' : 'Start recording'}
        >
          mic
        </button>
        <button class="control-button" disabled aria-label="Settings">
          settings
        </button>
      </div>
    `;
  }
}