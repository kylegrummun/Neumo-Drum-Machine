// Minimal client-only prototype using Tone.js
// Features: BPM, metronome toggle, pads, simple 16-step sequencer (4 parts), mic record to pad, live monitor, pitch shift 'autotune' beta.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// UI elements
const startBtn = $("#startAudio");
const bpm = $("#bpm");
const bpmVal = $("#bpmVal");
const metro = $("#metronome");
const swing = $("#swing");
const swingVal = $("#swingVal");
const pads = $$(".pad");
const seqRows = $$(".seq-row");
const seqClear = $("#seqClear");
const seqRandom = $("#seqRandom");
const seqPlay = $("#seqPlay");

const micEnable = $("#micEnable");
const micRecord = $("#micRecord");
const micClear = $("#micClear");
const monitor = $("#monitor");
const autotune = $("#autotune");
const keySel = $("#key");
const scaleSel = $("#scale");

let started = false;
let isPlaying = false;

const Transport = Tone.Transport;
Transport.loop = true;
Transport.loopStart = 0;
Transport.loopEnd = "1m";

// Master chain
const master = new Tone.Volume(0).toDestination();

// Click (metronome)
const clickSynth = new Tone.MetalSynth({
  frequency: 1000, envelope: { attack: 0.001, decay: 0.08, release: 0.01 },
  harmonicity: 5.1, modulationIndex: 32, resonance: 800, octaves: 1.5
}).connect(master);

let clickPart;

// Drum voices
const kick = new Tone.MembraneSynth({ pitchDecay: 0.01, octaves: 6, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.4, sustain: 0.0, release: 0.2 }}).connect(master);
const snareNoise = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.2, sustain: 0 } }).connect(master);
const hat = new Tone.MetalSynth({ frequency: 250, envelope: { attack: 0.001, decay: 0.07, release: 0.02 }, harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5 }).connect(master);
const clap = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.15, sustain: 0 }, noise: { type: "pink" } }).connect(master);
const tom = new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 4, envelope: { attack: 0.001, decay: 0.25, sustain: 0.0, release: 0.2 }}).connect(master);
const perc = new Tone.PluckSynth().connect(master);
const fx = new Tone.FMSynth({ modulationIndex: 12, envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 }}).connect(master);

// Voice sample slot (user recorded)
let userBuffer = null;
let userPlayer = new Tone.Player({ loop: false, autostart: false }).connect(master);

// Live mic chain
const userMedia = new Tone.UserMedia();
const pitchShift = new Tone.PitchShift({ pitch: 0, windowSize: 0.1, delayTime: 0.0, feedback: 0 }).connect(master);
let micConnected = false;

// Scale helpers
const NOTE_ORDER = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const SCALES = {
  major: [0,2,4,5,7,9,11],
  minor: [0,2,3,5,7,8,10],
  pentatonic: [0,3,5,7,10],
};

function nearestNoteInScale(freq, key, scaleName) {
  // Rough frequency->MIDI->snap->diff semitones
  const midi = Tone.Frequency(freq).toMidi();
  const keyIndex = NOTE_ORDER.indexOf(key);
  const scale = SCALES[scaleName];
  // Build notes for multiple octaves around midi
  let candidates = [];
  for (let oct=-2; oct<3; oct++){
    scale.forEach(deg => {
      candidates.push( (keyIndex + deg) + 12*(oct+5) ); // around middle
    });
  }
  // Find nearest
  let best = candidates.reduce((best, n) => {
    const d = Math.abs(n - midi);
    return d < best.d ? {n, d} : best;
  }, {n: candidates[0], d: 999});
  return best.n - midi; // semitone difference (can be negative)
}

// Naive pitch detection using autocorrelation (for short buffers)
function detectPitch(timeDomain, sampleRate){
  // Autocorrelation (very naive, good enough for quick "Tune Now" vibe)
  let bestOffset = -1, bestCorrelation = 0;
  const SIZE = timeDomain.length;
  const MAX_S = Math.floor(sampleRate/50); // 50 Hz floor
  const MIN_S = Math.floor(sampleRate/1000); // 1kHz ceiling
  for (let offset=MIN_S; offset<MAX_S; offset++){
    let corr = 0;
    for (let i=0; i<SIZE-offset; i++){
      corr += timeDomain[i]*timeDomain[i+offset];
    }
    corr /= SIZE;
    if (corr > bestCorrelation){ bestCorrelation = corr; bestOffset = offset; }
  }
  if (bestOffset > 0){
    return sampleRate / bestOffset;
  }
  return null;
}

// Sequencer state
const voices = ["kick","snare","hat","clap"];
const seqState = {};
voices.forEach(v => seqState[v] = new Array(16).fill(false));

function buildSequencerUI(){
  seqRows.forEach(row => {
    const v = row.getAttribute("data-voice");
    const steps = document.createElement("div");
    steps.className = "steps";
    for (let i=0;i<16;i++){
      const btn = document.createElement("button");
      btn.className = "step";
      btn.addEventListener("click", () => {
        seqState[v][i] = !seqState[v][i];
        btn.classList.toggle("on", seqState[v][i]);
      });
      steps.appendChild(btn);
    }
    row.appendChild(steps);
  });
}
buildSequencerUI();

let seqIndex = 0;
let seqId = null;

function triggerVoice(v){
  switch(v){
    case "kick": kick.triggerAttackRelease("C2","8n"); break;
    case "snare": snareNoise.triggerAttackRelease("8n"); break;
    case "hat": hat.triggerAttackRelease("8n"); break;
    case "clap": clap.triggerAttackRelease("16n"); break;
    case "tom": tom.triggerAttackRelease("G2","8n"); break;
    case "perc": perc.triggerAttackRelease("C4","16n"); break;
    case "fx": fx.triggerAttackRelease("C3","16n"); break;
    case "voice":
      if (userBuffer){
        userPlayer.buffer = userBuffer;
        userPlayer.start();
      }
      break;
  }
}

function updatePlayheadUI(step){
  $$(".step").forEach((el, idx) => el.classList.remove("playhead"));
  seqRows.forEach(row => {
    const steps = row.querySelectorAll(".step");
    steps[step].classList.add("playhead");
  });
}

function scheduleMetronome(){
  if (clickPart) { clickPart.dispose(); }
  clickPart = new Tone.Loop((time)=>{
    if (metro.checked){
      clickSynth.triggerAttackRelease("16n", time);
    }
  }, "4n").start(0);
}

function scheduleSequencer(){
  if (seqId){ seqId.dispose?.(); seqId = null; }
  seqIndex = 0;
  const loop = new Tone.Loop((time)=>{
    voices.forEach(v => {
      if (seqState[v][seqIndex]){
        triggerVoice(v);
      }
    });
    updatePlayheadUI(seqIndex);
    seqIndex = (seqIndex+1)%16;
  }, "16n").start(0);
  seqId = loop;
}

function setBPM(val){
  Transport.bpm.value = val;
  bpmVal.textContent = val;
}

function setSwing(val){
  Transport.swing = val/100; // 0..1
  swingVal.textContent = `${val}%`;
}

// Pad taps
pads.forEach(p => {
  p.addEventListener("click", () => {
    p.classList.add("active");
    setTimeout(()=>p.classList.remove("active"),100);
    triggerVoice(p.dataset.sound);
  });
});

// Start/stop
startBtn.addEventListener("click", async () => {
  if (!started){
    await Tone.start();
    started = true;
    scheduleMetronome();
    scheduleSequencer();
    startBtn.textContent = "Audio Ready ✅";
    startBtn.disabled = true;
  }
});

bpm.addEventListener("input", e => setBPM(e.target.value));
swing.addEventListener("input", e => setSwing(e.target.value));

seqPlay.addEventListener("click", async () => {
  if (!started){ await Tone.start(); started = true; scheduleMetronome(); scheduleSequencer(); }
  if (Transport.state === "started"){
    Transport.stop();
    isPlaying = false;
  } else {
    Transport.start("+0.05");
    isPlaying = true;
  }
});
seqClear.addEventListener("click", ()=>{
  voices.forEach(v => seqState[v] = new Array(16).fill(false));
  $$(".step").forEach(s => s.classList.remove("on"));
});
seqRandom.addEventListener("click", ()=>{
  voices.forEach(v => seqState[v] = new Array(16).fill(false).map(()=> Math.random() < 0.25));
  // update UI
  seqRows.forEach(row => {
    const v = row.getAttribute("data-voice");
    const steps = row.querySelectorAll(".step");
    steps.forEach((btn,i)=> btn.classList.toggle("on", seqState[v][i]));
  });
});

// Mic enable and monitor
micEnable.addEventListener("click", async ()=>{
  try{
    await userMedia.open();
    micConnected = true;
    micEnable.textContent = "Mic Enabled ✅";
    micEnable.disabled = true;
  }catch(e){
    alert("Mic access failed. Use HTTPS and allow microphone.");
  }
});

monitor.addEventListener("change", ()=>{
  if (!micConnected) return;
  if (monitor.checked){
    // Connect mic to destination via optional pitch shift
    if (autotune.checked){
      userMedia.connect(pitchShift);
    } else {
      userMedia.connect(master);
    }
  } else {
    userMedia.disconnect();
    pitchShift.disconnect();
    pitchShift.connect(master);
  }
});

autotune.addEventListener("change", ()=>{
  if (!micConnected) return;
  if (monitor.checked){
    userMedia.disconnect();
    if (autotune.checked){
      userMedia.connect(pitchShift);
    }else{
      userMedia.connect(master);
    }
  }
});

// Record to pad using MediaRecorder and map to userBuffer
let mediaRecorder;
let chunks = [];
micRecord.addEventListener("click", async ()=>{
  if (!navigator.mediaDevices) return alert("No mediaDevices API");
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    mediaRecorder = new MediaRecorder(stream);
    chunks = [];
    mediaRecorder.ondataavailable = e => chunks.push(e.data);
    mediaRecorder.onstop = async ()=>{
      const blob = new Blob(chunks, {type:"audio/webm"});
      const arrBuf = await blob.arrayBuffer();
      const toneBuf = await Tone.getContext().rawContext.decodeAudioData(arrBuf);
      userBuffer = new Tone.ToneAudioBuffer(toneBuf);
      alert("Recorded! Mapped to Voice pad.");
    };
    mediaRecorder.start();
    micRecord.textContent = "⏹️ Stop";
    const stopAfter = 1500; // 1.5s
    setTimeout(()=>{
      if (mediaRecorder && mediaRecorder.state === "recording"){
        mediaRecorder.stop();
        micRecord.textContent = "⏺️ Record to Pad";
      }
    }, stopAfter);
  }catch(e){
    alert("Mic record failed: "+e.message);
  }
});

micClear.addEventListener("click", ()=>{
  userBuffer = null;
  alert("Cleared recorded sample.");
});

// Simple "tune now": capture ~200ms from mic, detect pitch, set pitchShift to nearest scale
function tuneNowFromMic(){
  // We won't add a button; we react when enabling autotune while monitoring:
  // sample short buffer from WebAudio analyser and set pitch shift
}

setBPM(bpm.value);
setSwing(swing.value);

// Bonus: adjust pitch in realtime crudely by polling analyser when autotune is on
const analyser = new Tone.Analyser("waveform", 2048);
function ensureAnalyser(){
  if (!micConnected) return;
  userMedia.connect(analyser);
}
ensureAnalyser();

setInterval(()=>{
  if (micConnected && monitor.checked && autotune.checked){
    const waveform = analyser.getValue(); // Float32Array -1..1
    // Convert to plain array
    const arr = Array.from(waveform);
    // Skip if too quiet
    const rms = Math.sqrt(arr.reduce((s,v)=>s+v*v,0)/arr.length);
    if (rms < 0.02) return;
    const freq = detectPitch(arr, Tone.getContext().sampleRate);
    if (freq){
      const key = keySel.value; const scale = scaleSel.value;
      const semis = nearestNoteInScale(freq, key, scale);
      // clamp
      const clamped = Math.max(-12, Math.min(12, semis));
      pitchShift.pitch = clamped;
    }
  }
}, 150);
