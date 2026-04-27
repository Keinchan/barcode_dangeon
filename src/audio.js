// ─────────────────────────────────────────────
// Web Audio API ベースの BGM / SFX エンジン
//   - 外部音源ファイルを使わず、すべて手続き的に合成
//   - iOS Safari は user gesture でないと AudioContext が動かないので、
//     初回タップで lazy 起動する
//   - 設定（ON/OFF・音量）は localStorage に永続化
// ─────────────────────────────────────────────

const STORAGE_KEY = 'real_hide:audio:v1';

const settings = {
  bgmEnabled: true,
  sfxEnabled: true,
  bgmVolume:  0.35,
  sfxVolume:  0.55,
};
loadSettings();

let ctx          = null;        // AudioContext
let masterBgm    = null;        // BGM 用 GainNode
let masterSfx    = null;        // SFX 用 GainNode
let currentBgm   = null;        // { name, stop }
let pendingBgm   = null;        // ctx 起動前に要求されたら覚えておく
const initFns    = new Set();   // 起動完了通知

// ─── 初期化 ───
function ensureCtx() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  masterBgm = ctx.createGain();
  masterSfx = ctx.createGain();
  masterBgm.gain.value = settings.bgmEnabled ? settings.bgmVolume : 0;
  masterSfx.gain.value = settings.sfxEnabled ? settings.sfxVolume : 0;
  masterBgm.connect(ctx.destination);
  masterSfx.connect(ctx.destination);

  // ctx の状態遷移を拾う:
  //   running 遷移時 … pendingBgm or 直前まで鳴っていた currentBgm を再投入
  //   suspended 遷移時 … 鳴っていた BGM をスケジューラ毎切り捨て、名前だけ pending に
  //                      退避（ctx.currentTime が止まるとスケジューラが暴走するため）
  ctx.addEventListener('statechange', () => {
    if (ctx.state === 'running') {
      const name = pendingBgm ?? currentBgm?.name ?? null;
      if (name) {
        pendingBgm = null;
        if (currentBgm) {
          currentBgm.stop();
          currentBgm = null;
        }
        startBgm(name);
      }
    } else if (ctx.state === 'suspended') {
      // confirm/alert などのネイティブダイアログで suspended に落ちた場合の保全
      if (currentBgm) {
        const n = currentBgm.name;
        currentBgm.stop();
        currentBgm = null;
        pendingBgm = n;
      }
    }
  });
  return ctx;
}

function ensureRunning() {
  const c = ensureCtx();
  if (!c) return null;
  if (c.state === 'suspended') {
    c.resume().catch(() => {});
  }
  return c;
}

// 初回ユーザー操作で起動。iOS Safari 対策:
//   - **AudioContext はこのジェスチャ内で初めて生成する**。gesture 外で生成すると
//     その ctx は後から resume しても完全にロック解除されないケースがある。
//   - resume を await して、明示的に pendingBgm を投入する。statechange に頼らない。
//   - 1サンプルの空 BufferSource と silent oscillator を実際に start() して
//     audio policy 解除（resume だけでは効かない iOS 版がある）
//   - capture フェーズで拾うことで、子要素が stopPropagation していても発火
function unlockOnGesture() {
  let unlocked = false;
  const fire = async () => {
    if (unlocked) return;
    unlocked = true;
    const c = ensureCtx();
    if (!c) return;
    // ① resume を先に。gesture 内で resume を発行することが iOS 解除の必須条件
    if (c.state === 'suspended') {
      try { await c.resume(); } catch {}
    }
    // ② silent oscillator も鳴らす（一部の iOS は BufferSource のみだと解除されない）
    try {
      const o = c.createOscillator();
      const g = c.createGain();
      g.gain.value = 0;
      o.connect(g).connect(c.destination);
      o.start(0);
      o.stop(c.currentTime + 0.01);
    } catch {}
    // ③ unlock buffer
    try {
      const buf = c.createBuffer(1, 1, 22050);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.start(0);
    } catch {}
    // ④ 明示的に pendingBgm を投入（statechange に頼らない）
    if (pendingBgm) {
      const name = pendingBgm;
      pendingBgm = null;
      startBgm(name);
    }
    initFns.forEach(fn => { try { fn(); } catch {} });
    document.removeEventListener('pointerdown', fire, true);
    document.removeEventListener('keydown',     fire, true);
    document.removeEventListener('touchstart',  fire, true);
    document.removeEventListener('click',       fire, true);
  };
  document.addEventListener('pointerdown', fire, true);
  document.addEventListener('keydown',     fire, true);
  document.addEventListener('touchstart',  fire, true);
  document.addEventListener('click',       fire, true);

  // 常時アクティブな保険: クリックの度に suspended なら resume を試す。
  // alert/confirm 等のネイティブダイアログで suspended に落ちた場合、
  // ダイアログ閉幕後の最初のクリックで自動復帰させる。
  document.addEventListener('click', () => {
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }, true);

  // タブ復帰系イベントでも resume を試す（iOS は焦点系で発火しないこともあるが
  // PC ブラウザでは効く）
  const tryResume = () => {
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', tryResume);
  window.addEventListener('focus', tryResume);
  window.addEventListener('pageshow', tryResume);
}
unlockOnGesture();

// ─── 設定 ───
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    Object.assign(settings, JSON.parse(raw));
  } catch {}
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
}

export function getAudioSettings() {
  return { ...settings };
}

export function setBgmEnabled(v) {
  settings.bgmEnabled = !!v;
  persist();
  if (masterBgm) masterBgm.gain.value = settings.bgmEnabled ? settings.bgmVolume : 0;
  if (!settings.bgmEnabled) stopBgm();
}

export function setSfxEnabled(v) {
  settings.sfxEnabled = !!v;
  persist();
  if (masterSfx) masterSfx.gain.value = settings.sfxEnabled ? settings.sfxVolume : 0;
}

export function setBgmVolume(v) {
  settings.bgmVolume = Math.max(0, Math.min(1, v));
  persist();
  if (masterBgm && settings.bgmEnabled) masterBgm.gain.value = settings.bgmVolume;
}

export function setSfxVolume(v) {
  settings.sfxVolume = Math.max(0, Math.min(1, v));
  persist();
  if (masterSfx && settings.sfxEnabled) masterSfx.gain.value = settings.sfxVolume;
}

// ─── 音階（A4=440 を基準にした半音テーブル） ───
//   note: 0=C, 1=C#, ..., 11=B  / octave: 4 が中央オクターブ
function noteFreq(note, octave) {
  // C4 = MIDI 60 = 261.63Hz
  const midi = 12 * (octave + 1) + note;
  return 440 * Math.pow(2, (midi - 69) / 12);
}
const N = { C:0, Db:1, D:2, Eb:3, E:4, F:5, Gb:6, G:7, Ab:8, A:9, Bb:10, B:11 };

// ─── 単音再生（BGM の各ノート / SFX 共通のラッパー）───
function playTone(at, freq, dur, opts = {}) {
  if (!ctx) return;
  const dest   = opts.dest ?? masterSfx;
  const type   = opts.type ?? 'square';
  const vol    = opts.vol ?? 0.4;
  const attack = opts.attack ?? 0.01;
  const decay  = opts.decay  ?? Math.max(0.05, dur * 0.6);

  const osc = ctx.createOscillator();
  const g   = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  if (opts.sweepTo) {
    osc.frequency.linearRampToValueAtTime(opts.sweepTo, at + dur);
  }
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(attack + 0.01, decay));
  osc.connect(g).connect(dest);
  osc.start(at);
  osc.stop(at + Math.max(attack + 0.01, decay) + 0.05);
  return { osc, g };
}

function playNoise(at, dur, opts = {}) {
  if (!ctx) return;
  const dest = opts.dest ?? masterSfx;
  const vol  = opts.vol ?? 0.25;
  const len  = Math.max(0.01, dur);
  const buf  = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + len);
  // ハイパスでパチパチ感を残す
  if (opts.highpass) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = opts.highpass;
    src.connect(f).connect(g).connect(dest);
  } else {
    src.connect(g).connect(dest);
  }
  src.start(at);
  src.stop(at + len + 0.02);
}

// ─── BGM トラック定義 ───
//   各トラック: { bpm, beats, build(t0, beat) }
//   beat: 1拍の秒数。build は相対 t を返さず、絶対時刻でスケジュールする
const BGM_TRACKS = {
  // タイトル: 落ち着いたメジャーキーのアルペジオ
  title: {
    loopBeats: 16,
    bpm: 90,
    schedule(t0, beat, dest) {
      // C major: C, E, G, C, B, G, E, C ...
      const notes = [
        N.C, N.E, N.G, N.B,  N.C, N.G, N.E, N.G,
        N.A, N.E, N.G, N.B,  N.G, N.E, N.C, N.E,
      ];
      for (let i = 0; i < notes.length; i++) {
        playTone(t0 + i * beat, noteFreq(notes[i], 5), beat * 0.9, {
          type: 'triangle', vol: 0.18, dest, attack: 0.02, decay: beat * 0.85,
        });
      }
      // ベース
      const bass = [N.C, N.C, N.G, N.G,  N.A, N.A, N.F, N.G];
      for (let i = 0; i < bass.length; i++) {
        playTone(t0 + i * beat * 2, noteFreq(bass[i], 3), beat * 1.6, {
          type: 'sine', vol: 0.18, dest, attack: 0.02, decay: beat * 1.6,
        });
      }
    },
  },

  // マップ: 軽快な歩行リズム
  map: {
    loopBeats: 16,
    bpm: 110,
    schedule(t0, beat, dest) {
      const lead = [
        N.E, N.G, N.A, N.G,  N.E, N.D, N.E, N.G,
        N.E, N.G, N.A, N.B,  N.A, N.G, N.E, N.D,
      ];
      for (let i = 0; i < lead.length; i++) {
        playTone(t0 + i * beat, noteFreq(lead[i], 5), beat * 0.8, {
          type: 'square', vol: 0.14, dest, attack: 0.005, decay: beat * 0.7,
        });
      }
      const bass = [N.A, N.E, N.A, N.E,  N.A, N.E, N.D, N.E];
      for (let i = 0; i < bass.length; i++) {
        playTone(t0 + i * beat * 2, noteFreq(bass[i], 3), beat * 1.7, {
          type: 'triangle', vol: 0.22, dest, attack: 0.01, decay: beat * 1.6,
        });
      }
    },
  },

  // ダンジョン: 暗めのマイナーキードローン
  dungeon: {
    loopBeats: 16,
    bpm: 80,
    schedule(t0, beat, dest) {
      // A minor: A, C, E, G の組み合わせ
      const lead = [
        N.A, N.E, N.A, N.C,  N.E, N.D, N.C, N.E,
        N.A, N.G, N.A, N.C,  N.E, N.G, N.E, N.C,
      ];
      for (let i = 0; i < lead.length; i++) {
        const oct = i % 4 === 0 ? 5 : 4;
        playTone(t0 + i * beat, noteFreq(lead[i], oct), beat * 1.0, {
          type: 'triangle', vol: 0.15, dest, attack: 0.05, decay: beat * 0.95,
        });
      }
      // ベースドローン
      const bass = [N.A, N.A, N.F, N.G,  N.A, N.A, N.D, N.E];
      for (let i = 0; i < bass.length; i++) {
        playTone(t0 + i * beat * 2, noteFreq(bass[i], 2), beat * 1.9, {
          type: 'sine', vol: 0.28, dest, attack: 0.05, decay: beat * 1.9,
        });
      }
    },
  },

  // バトル: 速いマイナー攻めパターン
  battle: {
    loopBeats: 16,
    bpm: 150,
    schedule(t0, beat, dest) {
      const lead = [
        N.A, N.E, N.A, N.C,  N.E, N.A, N.E, N.C,
        N.G, N.D, N.G, N.B,  N.D, N.G, N.D, N.B,
      ];
      for (let i = 0; i < lead.length; i++) {
        playTone(t0 + i * beat, noteFreq(lead[i], 5), beat * 0.85, {
          type: 'square', vol: 0.16, dest, attack: 0.005, decay: beat * 0.75,
        });
      }
      const bass = [N.A, N.A, N.A, N.G,  N.A, N.A, N.F, N.G];
      for (let i = 0; i < bass.length; i++) {
        playTone(t0 + i * beat * 2, noteFreq(bass[i], 3), beat * 1.3, {
          type: 'sawtooth', vol: 0.18, dest, attack: 0.01, decay: beat * 1.0,
        });
      }
      // 16分のキック相当
      for (let i = 0; i < 16; i++) {
        if (i % 2 === 0) playNoise(t0 + i * beat, beat * 0.1, { vol: 0.18, dest, highpass: 1500 });
      }
    },
  },
};

// ─── BGM 再生 ───
//   各 BGM セッションは専用 voice GainNode を介して masterBgm に接続する。
//   stop 時は voice を disconnect することで、まだ未到達のスケジュール済オシレータも
//   含めて確実に無音化する（master を絞ってすぐ戻す方式は、戻した瞬間に未到達ノートが
//   鳴ってしまうバグがあったため廃止）。
//
//   重要: ctx がまだ無い／suspended の段階では絶対に ensureCtx を呼ばない。
//   gesture 外で AudioContext を作ると iOS で恒久ロックされるケースがあるため、
//   初回 gesture が来るまでは pendingBgm に名前を積むだけにする。
export function startBgm(name) {
  if (!settings.bgmEnabled) { stopBgm(); pendingBgm = null; return; }
  if (!ctx || ctx.state === 'suspended') {
    pendingBgm = name;
    return;
  }
  const c = ctx;
  if (currentBgm?.name === name) return;
  stopBgm();

  const track = BGM_TRACKS[name];
  if (!track) return;

  const voice = c.createGain();
  voice.gain.value = 1;
  voice.connect(masterBgm);

  const beat    = 60 / track.bpm;
  const loopSec = track.loopBeats * beat;
  let cancelled = false;
  let nextStart = c.currentTime + 0.05;
  let timer     = null;

  const scheduleOne = () => {
    if (cancelled) return;
    track.schedule(nextStart, beat, voice);
    nextStart += loopSec;
    // ループを切れ目なくつなぐため、半ループ前に再スケジュール
    const aheadMs = Math.max(50, (nextStart - c.currentTime - loopSec * 0.5) * 1000);
    timer = setTimeout(scheduleOne, aheadMs);
  };
  scheduleOne();

  currentBgm = {
    name,
    voice,
    stop() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // voice を切ることで、未到達ノートを含めて即座に完全無音化
      try { voice.disconnect(); } catch {}
    },
  };
}

export function stopBgm() {
  pendingBgm = null;
  if (currentBgm) currentBgm.stop();
  currentBgm = null;
}

export function getCurrentBgmName() {
  return currentBgm?.name ?? null;
}

// ─── SFX ───
//   レアリティ補正なし。レア度別の差はアイテム取得時のレア度引数で出す
const SFX = {
  pickup(opts = {}) {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    const tier = opts.rarityTier ?? 0;     // 0..3
    // レアリティで全く別パターンの効果音を鳴らし、聞き分けが付くようにする
    if (tier === 0) {
      // コモン: 短い「コン」だけ
      playTone(t,        660, 0.08, { type: 'triangle', vol: 0.28 });
      playTone(t + 0.05, 880, 0.07, { type: 'triangle', vol: 0.22 });
    } else if (tier === 1) {
      // レア: 上昇2音 + ハイライトのチャイム
      playTone(t,        noteFreq(N.E, 5), 0.10, { type: 'triangle', vol: 0.30 });
      playTone(t + 0.09, noteFreq(N.A, 5), 0.14, { type: 'triangle', vol: 0.30 });
      playTone(t + 0.20, noteFreq(N.E, 6), 0.20, { type: 'sine',     vol: 0.22 });
    } else if (tier === 2) {
      // エピック: メジャー3和音 + キラキラ
      const chord = [N.C, N.E, N.G];
      for (let i = 0; i < chord.length; i++) {
        playTone(t + i * 0.05, noteFreq(chord[i], 5), 0.22, {
          type: 'triangle', vol: 0.28,
        });
      }
      playTone(t + 0.18, noteFreq(N.C, 6), 0.30, { type: 'sine', vol: 0.26 });
      playTone(t + 0.34, noteFreq(N.E, 6), 0.26, { type: 'sine', vol: 0.22 });
      playNoise(t + 0.10, 0.06, { vol: 0.10, highpass: 5000 });
    } else {
      // レジェンド: フルファンファーレ（4音上昇 + 高音和音 + 余韻）
      const seq = [N.C, N.E, N.G, N.C];
      for (let i = 0; i < seq.length; i++) {
        playTone(t + i * 0.10, noteFreq(seq[i], i === 3 ? 6 : 5), 0.22, {
          type: 'triangle', vol: 0.32,
        });
      }
      // 同時和音（上ハモ）
      playTone(t + 0.40, noteFreq(N.E, 6), 0.40, { type: 'sine', vol: 0.26 });
      playTone(t + 0.40, noteFreq(N.G, 6), 0.40, { type: 'sine', vol: 0.22 });
      playTone(t + 0.40, noteFreq(N.C, 7), 0.50, { type: 'sine', vol: 0.20 });
      // ベース
      playTone(t,        noteFreq(N.C, 3), 0.45, { type: 'sawtooth', vol: 0.18 });
      // キラキラ余韻
      playNoise(t + 0.04, 0.10, { vol: 0.15, highpass: 6000 });
      playNoise(t + 0.50, 0.18, { vol: 0.12, highpass: 5000 });
    }
  },

  drop(opts = {}) {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    const tier = opts.rarityTier ?? 0;
    playTone(t, 280 + tier * 60, 0.16, {
      type: 'sawtooth', vol: 0.28, sweepTo: 700 + tier * 200,
    });
    playTone(t + 0.12, 600 + tier * 100, 0.18, { type: 'triangle', vol: 0.22 });
  },

  levelup() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    const seq = [N.C, N.E, N.G, N.C];
    for (let i = 0; i < seq.length; i++) {
      playTone(t + i * 0.09, noteFreq(seq[i], i === 3 ? 6 : 5), 0.18, {
        type: 'triangle', vol: 0.32,
      });
    }
    playNoise(t + 0.36, 0.12, { vol: 0.18, highpass: 4000 });
  },

  hit() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playNoise(t, 0.08, { vol: 0.32, highpass: 1200 });
    playTone(t, 220, 0.10, { type: 'square', vol: 0.22, sweepTo: 110 });
  },

  crit() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playNoise(t, 0.10, { vol: 0.40, highpass: 800 });
    playTone(t, 880, 0.16, { type: 'square', vol: 0.30, sweepTo: 200 });
  },

  damage() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playTone(t, 200, 0.20, { type: 'sawtooth', vol: 0.30, sweepTo: 80 });
    playNoise(t, 0.14, { vol: 0.20, highpass: 400 });
  },

  stairs() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playTone(t,        noteFreq(N.G, 4), 0.12, { type: 'triangle', vol: 0.28 });
    playTone(t + 0.10, noteFreq(N.E, 4), 0.14, { type: 'triangle', vol: 0.26 });
    playTone(t + 0.22, noteFreq(N.C, 4), 0.20, { type: 'triangle', vol: 0.24 });
  },

  boss() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playTone(t,        80,  0.30, { type: 'sawtooth', vol: 0.40 });
    playTone(t + 0.10, 110, 0.30, { type: 'sawtooth', vol: 0.36 });
    playNoise(t + 0.30, 0.40, { vol: 0.25, highpass: 200 });
  },

  click() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playTone(t, 1200, 0.05, { type: 'square', vol: 0.14 });
  },

  // 装備時: 鞘走りのような上昇音 + ハイチャイム
  equip() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playTone(t,        660, 0.07, { type: 'triangle', vol: 0.26 });
    playTone(t + 0.05, 990, 0.10, { type: 'triangle', vol: 0.28 });
    playTone(t + 0.12, 1320, 0.20, { type: 'sine',    vol: 0.20 });
  },

  // 装備解除: 下降2音
  unequip() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playTone(t,        880, 0.07, { type: 'triangle', vol: 0.22 });
    playTone(t + 0.06, 587, 0.12, { type: 'triangle', vol: 0.20 });
  },

  // 廃棄: 低い下降スイープ + 軽いノイズ
  discard() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playTone(t, 260, 0.18, { type: 'sawtooth', vol: 0.24, sweepTo: 90 });
    playNoise(t, 0.10, { vol: 0.15, highpass: 200 });
  },

  // 薬を飲む: ノイズ＋上昇音で「ぐびっ」感
  drink() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playNoise(t, 0.18, { vol: 0.16, highpass: 1200 });
    playTone(t + 0.04, 440, 0.14, { type: 'sine', vol: 0.22, sweepTo: 880 });
  },

  // 選択（ダンジョン選択など）: 軽快な2音上昇
  select() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    playTone(t,        noteFreq(N.G, 5), 0.06, { type: 'triangle', vol: 0.22 });
    playTone(t + 0.05, noteFreq(N.C, 6), 0.10, { type: 'triangle', vol: 0.22 });
  },

  // 確定（潜入する など、強めの GO 系）: 明るい3音
  confirm() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    const seq = [N.C, N.E, N.G];
    for (let i = 0; i < seq.length; i++) {
      playTone(t + i * 0.06, noteFreq(seq[i], 5), 0.10, { type: 'triangle', vol: 0.24 });
    }
  },

  defeat() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    const seq = [N.G, N.F, N.E, N.D, N.C];
    for (let i = 0; i < seq.length; i++) {
      playTone(t + i * 0.12, noteFreq(seq[i], 4), 0.22, {
        type: 'triangle', vol: 0.26,
      });
    }
  },

  victory() {
    const t = ensureRunning()?.currentTime; if (t == null) return;
    const seq = [N.C, N.E, N.G, N.C, N.G, N.C];
    for (let i = 0; i < seq.length; i++) {
      playTone(t + i * 0.10, noteFreq(seq[i], i >= 3 ? 6 : 5), 0.18, {
        type: 'triangle', vol: 0.30,
      });
    }
  },
};

export function playSfx(name, opts) {
  if (!settings.sfxEnabled) return;
  const fn = SFX[name];
  if (!fn) return;
  ensureRunning();
  fn(opts);
}

// レアリティ名→tier 0..3 ヘルパ（呼び出し側で楽できるように）
export function rarityTier(rarityName) {
  switch (rarityName) {
    case 'レア':       return 1;
    case 'エピック':   return 2;
    case 'レジェンド': return 3;
    default:           return 0;
  }
}

export const BGM_NAMES = Object.keys(BGM_TRACKS);
export const SFX_NAMES = Object.keys(SFX);
