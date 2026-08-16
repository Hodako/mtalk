/**
 * MTalk Audio Synthesizer & Spectrum Visualizer
 * Uses Web Audio API to produce sound effects without external audio file dependencies
 */

class SoundEffects {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  initContext() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.ctx = new AudioContext();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playMatchFound() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';

    // Uplifting chord progression: C5 -> E5 -> G5 -> C6
    osc1.frequency.setValueAtTime(523.25, now);
    osc1.frequency.setValueAtTime(659.25, now + 0.08);
    osc1.frequency.setValueAtTime(783.99, now + 0.16);
    osc1.frequency.setValueAtTime(1046.50, now + 0.24);

    osc2.frequency.setValueAtTime(261.63, now);
    osc2.frequency.setValueAtTime(329.63, now + 0.08);
    osc2.frequency.setValueAtTime(392.00, now + 0.16);
    osc2.frequency.setValueAtTime(523.25, now + 0.24);

    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.65);
    osc2.stop(now + 0.65);
  }

  playMessagePop() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);

    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.12);
  }

  playSkip() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + 0.15);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.15);
  }

  playDisconnect() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.setValueAtTime(240, now + 0.12);
    osc.frequency.setValueAtTime(180, now + 0.24);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.45);
  }

  playButtonClick() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(700, now);

    gain.gain.setValueAtTime(0.06, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.04);
  }
}

/**
 * Visualizer class that renders an animated soundwave / equalizer on a canvas
 */
class AudioWaveVisualizer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d');
    }
    this.analyser = null;
    this.dataArray = null;
    this.animationId = null;
    this.audioContext = null;
    this.source = null;
    this.isSpeaking = false;
    this.onSpeakingStateChange = null;
  }

  connectStream(mediaStream) {
    try {
      if (!this.audioContext) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioContext();
      }

      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }

      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(bufferLength);

      this.source = this.audioContext.createMediaStreamSource(mediaStream);
      this.source.connect(this.analyser);

      this.startRendering();
    } catch (e) {
      console.warn('Could not initialize audio visualizer for stream:', e);
    }
  }

  startRendering() {
    if (!this.canvas || !this.ctx || !this.analyser) return;

    const render = () => {
      this.animationId = requestAnimationFrame(render);
      this.analyser.getByteFrequencyData(this.dataArray);

      const width = this.canvas.width;
      const height = this.canvas.height;
      this.ctx.clearRect(0, 0, width, height);

      let sum = 0;
      const barCount = 18;
      const barWidth = (width / barCount) - 3;

      for (let i = 0; i < barCount; i++) {
        const val = this.dataArray[i % this.dataArray.length] || 0;
        sum += val;
        const barHeight = Math.max(4, (val / 255) * height);

        const x = i * (barWidth + 3);
        const y = (height - barHeight) / 2;

        const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, '#6366f1');
        gradient.addColorStop(1, '#a855f7');

        this.ctx.fillStyle = gradient;
        this.ctx.beginPath();
        this.ctx.roundRect(x, y, barWidth, barHeight, [3]);
        this.ctx.fill();
      }

      const avg = sum / barCount;
      const speaking = avg > 25;
      if (speaking !== this.isSpeaking) {
        this.isSpeaking = speaking;
        if (this.onSpeakingStateChange) {
          this.onSpeakingStateChange(this.isSpeaking);
        }
      }
    };

    render();
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.isSpeaking = false;
  }
}

window.SoundEffects = new SoundEffects();
window.AudioWaveVisualizer = AudioWaveVisualizer;
