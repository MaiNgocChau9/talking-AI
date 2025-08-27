// utils.js

export function encode(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decode(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// The API expects an object with { mimeType, data (base64) }
export function createBlobFromFloat32(float32) {
  const l = float32.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    let s = float32[i];
    // Clamp to [-1, 1] just in case
    s = Math.max(-1, Math.min(1, s));
    int16[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

export async function decodeAudioPCMToBuffer(
  dataUint8,
  audioCtx,
  sampleRate,
  numChannels
) {
  const frameCount = dataUint8.length / 2 / numChannels;
  const buffer = audioCtx.createBuffer(numChannels, frameCount, sampleRate);

  const dataInt16 = new Int16Array(
    dataUint8.buffer,
    dataUint8.byteOffset,
    Math.floor(dataUint8.byteLength / 2)
  );

  // Deinterleave into Float32 per channel
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    let writeIndex = 0;
    for (let i = ch; i < dataInt16.length; i += numChannels) {
      channelData[writeIndex++] = dataInt16[i] / 32768;
    }
  }
  return buffer;
}