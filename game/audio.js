/**
 * audio.js — all sound is synthesized with WebAudio. No audio files.
 *
 *  - a two-oscillator engine hum whose pitch follows airspeed
 *  - filtered wind noise that grows with speed
 *  - one-shot effects: ring chime, checkpoint fanfare, crash, click,
 *    countdown beeps and a finish jingle
 *
 * Everything is created lazily on the first user gesture (browser policy).
 */

export class SoundBank {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.engine = null;
  }

  /** Call from a click / tap handler. Safe to call repeatedly. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(this.ctx.destination);
    this.buildEngine();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
    }
  }

  buildEngine() {
    const ctx = this.ctx;
    // Engine: sawtooth + square through a lowpass, pitch set by setEngine().
    const oscA = ctx.createOscillator();
    oscA.type = "sawtooth";
    oscA.frequency.value = 55;
    const oscB = ctx.createOscillator();
    oscB.type = "square";
    oscB.frequency.value = 28;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 320;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    oscA.start();
    oscB.start();

    // Wind: looped white-noise buffer through a bandpass.
    const len = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 600;
    band.Q.value = 0.6;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    noise.connect(band);
    band.connect(windGain);
    windGain.connect(this.master);
    noise.start();

    this.engine = { oscA, oscB, filter, gain, band, windGain };
  }

  /** speedNorm: 0..1.5 airspeed factor; running: engine audible. */
  setEngine(speedNorm, running) {
    if (!this.ctx || !this.engine) return;
    const t = this.ctx.currentTime;
    const e = this.engine;
    const target = running ? 0.05 + Math.min(0.05, speedNorm * 0.03) : 0;
    e.gain.gain.setTargetAtTime(target, t, 0.12);
    const freq = 48 + speedNorm * 52;
    e.oscA.frequency.setTargetAtTime(freq, t, 0.1);
    e.oscB.frequency.setTargetAtTime(freq * 0.5 + 2, t, 0.1);
    e.filter.frequency.setTargetAtTime(240 + speedNorm * 480, t, 0.15);
    e.windGain.gain.setTargetAtTime(running ? Math.min(0.16, speedNorm * speedNorm * 0.14) : 0, t, 0.2);
    e.band.frequency.setTargetAtTime(400 + speedNorm * 700, t, 0.2);
  }

  /** A short synthesized tone with an envelope. */
  tone(freq, dur, { type = "sine", vol = 0.2, when = 0, slideTo = null, delay = 0 } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + when + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  noiseBurst(dur, vol, freqFrom, freqTo) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(freqFrom, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(freqTo, ctx.currentTime + dur);
    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();
  }

  click() {
    this.tone(660, 0.07, { type: "triangle", vol: 0.15 });
  }

  countBeep(final) {
    this.tone(final ? 880 : 440, final ? 0.35 : 0.14, { type: "square", vol: 0.12 });
  }

  ringChime(combo) {
    const base = 620 * Math.pow(1.059, Math.min(combo, 12));
    this.tone(base, 0.22, { type: "sine", vol: 0.22 });
    this.tone(base * 1.5, 0.3, { type: "sine", vol: 0.16, delay: 0.05 });
    this.tone(base * 2, 0.36, { type: "triangle", vol: 0.1, delay: 0.1 });
  }

  checkpoint() {
    const notes = [523, 659, 784];
    notes.forEach((f, i) => this.tone(f, 0.24, { type: "triangle", vol: 0.16, delay: i * 0.07 }));
  }

  crash() {
    this.noiseBurst(0.45, 0.5, 900, 90);
    this.tone(110, 0.4, { type: "sawtooth", vol: 0.2, slideTo: 38 });
  }

  splash() {
    this.noiseBurst(0.6, 0.35, 2400, 300);
  }

  finish() {
    const notes = [523, 659, 784, 1047, 784, 1047];
    notes.forEach((f, i) => this.tone(f, 0.34, { type: "triangle", vol: 0.17, delay: i * 0.11 }));
  }

  denied() {
    this.tone(196, 0.16, { type: "square", vol: 0.1 });
  }
}
