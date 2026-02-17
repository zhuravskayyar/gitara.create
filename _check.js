// ===================== AUDIO ENGINE =====================
const AudioContext = window.AudioContext || window.webkitAudioContext;
let ctx = null;
let masterGain = null;
let dryGain = null;
let bodyHighPass = null;
let bodyLowPass = null;
let bodyPeak = null;
let bodyCompressor = null;
let wafPlayer = null;
let wafReverb = null;
let reverbGain = null;
let reverbFilter = null;
let currentInstrument = null;
let instrumentLoaded = false;
let guitarType = 'steel';
let activeInstruments = ['steel'];
let loadedInstruments = {};
const instrumentLoadPromises = {};
let activeVoices = [];
const MAX_ACTIVE_VOICES = 28;
const USE_WAF_NATIVE_CHORD_API = true;

// --- Bass instrument bus ---
let bassLowPass = null;
let bassCompressor = null;
let bassBusGain = null;

// --- Chord-group voice tracking ---
let currentChordGroupId = 0;

// --- Voice leading state ---
let previousVoicingPitches = null;

// ===================== MULTI-TRACK SYSTEM =====================
// Each track has independent instruments, steps, voices & chordGroupId.
// When tracks[] is empty the engine falls back to the legacy single-track mode.
let tracks = [];          // array of track objects
let activeTrackIndex = 0; // currently selected track in UI

function createTrack(opts = {}) {
  return {
    name:        opts.name        || 'Track',
    instruments: sanitizeInstrumentList(opts.instruments || ['steel'], 'steel'),
    steps:       Array.isArray(opts.steps) ? opts.steps : null, // null = share main steps
    volume:      Number.isFinite(opts.volume) ? clamp(opts.volume, 0, 1) : 1,
    mute:        Boolean(opts.mute),
    solo:        Boolean(opts.solo),
    // per-track playback state
    chordGroupId: 0,
    activeVoices: [],
    previousVoicingPitches: null,
  };
}

function getTrackSteps(track) {
  return Array.isArray(track.steps) && track.steps.length ? track.steps : steps;
}

function isTrackAudible(track, allTracks) {
  if (track.mute) return false;
  const hasSolo = allTracks.some(t => t.solo);
  return hasSolo ? track.solo : true;
}

function getAudibleTracks() {
  if (!tracks.length) return null; // null = legacy mode
  return tracks.filter(t => isTrackAudible(t, tracks));
}

// Per-track voice management
function registerTrackVoice(track, voice) {
  if (!voice || typeof voice.stop !== 'function') return;
  voice.chordGroupId = track ? track.chordGroupId : currentChordGroupId;
  voice._trackId = track ? tracks.indexOf(track) : -1;
  if (track) {
    pruneTrackVoices(track);
    track.activeVoices.push(voice);
    while (track.activeVoices.length > MAX_ACTIVE_VOICES) {
      const oldest = track.activeVoices.shift();
      stopTrackedVoice(oldest, 0.012);
    }
  } else {
    registerActiveVoice(voice);
  }
}

function pruneTrackVoices(track) {
  if (!ctx || !track.activeVoices.length) return;
  const now = ctx.currentTime;
  track.activeVoices = track.activeVoices.filter(v =>
    !Number.isFinite(v.expiresAt) || v.expiresAt > now - 0.05
  );
}

function stopPreviousTrackVoices(track, releaseSecs = 0.025) {
  if (!track || !track.activeVoices.length) return;
  const threshold = track.chordGroupId - 1;
  const toStop = [];
  track.activeVoices = track.activeVoices.filter(v => {
    if (Number.isFinite(v.chordGroupId) && v.chordGroupId <= threshold) {
      toStop.push(v);
      return false;
    }
    return true;
  });
  toStop.forEach(v => stopTrackedVoice(v, releaseSecs));
}

function stopAllTrackVoices(releaseSecs = 0.025) {
  tracks.forEach(t => {
    const voices = t.activeVoices.splice(0, t.activeVoices.length);
    voices.forEach(v => stopTrackedVoice(v, releaseSecs));
  });
}

// --- Lookahead scheduler ---
let schedulerIntervalId = null;
let nextStepAudioTime = 0;
let nextStepIndex = 0;
const SCHEDULER_LOOKAHEAD_MS = 150;
const SCHEDULER_TICK_MS = 25;

const WEBAUDIOFONT_SOUND_BASE = 'https://surikov.github.io/webaudiofontdata/sound';

function formatProgramId(program) {
  return String(Math.max(0, Math.round(program))).padStart(4, '0');
}

/* ── Soundfont short-name maps ── */
const SF_SHORT = {
  'Aspirin_sf2_file':'asp','Chaos_sf2_file':'cha','FluidR3_GM_sf2_file':'flu',
  'GeneralUserGS_sf2_file':'gus','JCLive_sf2_file':'jcl',
  'LK_Godin_Nylon_SF2_file':'gdn','SBLive_sf2':'sbl','SoundBlasterOld_sf2':'sbo',
  'Acoustic_Guitar_sf2_file':'acg','LK_AcousticSteel_SF2_file':'acs',
  'Stratocaster_sf2_file':'str','Gibson_Les_Paul_sf2_file':'glp',
  'SBAWE32_sf2_file':'awe','LesPaul_sf2':'lp1','LesPaul_sf2_file':'lp2',
  'Soul_Ahhs_sf2_file':'sah',
};
const SF_LABEL = {
  'Aspirin_sf2_file':'Aspirin','Chaos_sf2_file':'Chaos',
  'FluidR3_GM_sf2_file':'FluidR3 GM','GeneralUserGS_sf2_file':'GeneralUser GS',
  'JCLive_sf2_file':'JC Live','LK_Godin_Nylon_SF2_file':'Godin Nylon',
  'SBLive_sf2':'SB Live','SoundBlasterOld_sf2':'SoundBlaster Old',
  'Acoustic_Guitar_sf2_file':'Acoustic Guitar','LK_AcousticSteel_SF2_file':'LK AcSteel',
  'Stratocaster_sf2_file':'Stratocaster','Gibson_Les_Paul_sf2_file':'Gibson LP',
  'SBAWE32_sf2_file':'AWE32','LesPaul_sf2':'Les Paul','LesPaul_sf2_file':'Les Paul Ext',
  'Soul_Ahhs_sf2_file':'Soul Ahhs',
};

function createWebAudioFontInstrument(program, label, options = {}) {
  const id = typeof program === 'string' ? program : formatProgramId(program);
  const sf = options.soundfont || 'FluidR3_GM_sf2_file';
  return {
    varName: `_tone_${id}_${sf}`,
    url: `${WEBAUDIOFONT_SOUND_BASE}/${id}_${sf}.js`,
    label,
    shortLabel: options.shortLabel || label,
    category: options.category || '',
    group: options.group || '',
    program: parseInt(id, 10),
    mixGain: Number.isFinite(options.mixGain) ? options.mixGain : 0.9,
    pitchShift: Number.isFinite(options.pitchShift) ? options.pitchShift : 0,
    durationMul: Number.isFinite(options.durationMul) ? options.durationMul : 1,
    bassOnly: Boolean(options.bassOnly),
  };
}

/* ── Instrument category order (for UI grouping) ── */
const INSTRUMENT_GROUP_ORDER = [
  'nyl','stl','jazz','cln','mut','ovr','dst','harm',
  'ab','bf','bp','fl','s1','s2','y1','y2'
];
const INSTRUMENT_GROUP_LABELS = {
  nyl:'🎸 Нейлон',stl:'🎸 Сталь',jazz:'⚡ Джаз',cln:'⚡ Чиста',
  mut:'⚡ Приглуш.',ovr:'🔥 Овердрайв',dst:'🔥 Дісторшн',harm:'✨ Гармоніки',
  ab:'🎸 Акуст.бас',bf:'🎸 Бас палець',bp:'🎸 Бас медіатор',fl:'🎸 Безладовий',
  s1:'🎸 Слеп 1',s2:'🎸 Слеп 2',y1:'🎹 Синт.бас 1',y2:'🎹 Синт.бас 2',
};

const INSTRUMENT_LIBRARY = (() => {
  const lib = {};

  /* Compact catalog: each group holds [fileId, ...] where fileId = "PPPP_SoundfontName" */
  const CATALOG = [
    { p:'nyl', name:'Nylon Guitar', cat:'guitar', g:0.92, d:1.0, items:[
      '0240_Aspirin_sf2_file','0240_Chaos_sf2_file','0240_FluidR3_GM_sf2_file',
      '0240_GeneralUserGS_sf2_file','0240_JCLive_sf2_file','0240_LK_Godin_Nylon_SF2_file',
      '0240_SBLive_sf2','0240_SoundBlasterOld_sf2',
      '0241_GeneralUserGS_sf2_file','0241_JCLive_sf2_file',
      '0242_JCLive_sf2_file','0243_JCLive_sf2_file']},
    { p:'stl', name:'Steel Guitar', cat:'guitar', g:1.0, d:1.0, items:[
      '0250_Acoustic_Guitar_sf2_file','0250_Aspirin_sf2_file','0250_Chaos_sf2_file',
      '0250_FluidR3_GM_sf2_file','0250_GeneralUserGS_sf2_file','0250_JCLive_sf2_file',
      '0250_LK_AcousticSteel_SF2_file','0250_SBLive_sf2','0250_SoundBlasterOld_sf2',
      '0251_Acoustic_Guitar_sf2_file','0251_GeneralUserGS_sf2_file',
      '0252_Acoustic_Guitar_sf2_file','0252_GeneralUserGS_sf2_file',
      '0253_Acoustic_Guitar_sf2_file','0253_GeneralUserGS_sf2_file',
      '0254_Acoustic_Guitar_sf2_file','0254_GeneralUserGS_sf2_file',
      '0255_GeneralUserGS_sf2_file']},
    { p:'jazz', name:'Jazz Electric', cat:'guitar', g:0.9, d:0.96, items:[
      '0260_Aspirin_sf2_file','0260_Chaos_sf2_file','0260_FluidR3_GM_sf2_file',
      '0260_GeneralUserGS_sf2_file','0260_JCLive_sf2_file','0260_SBLive_sf2',
      '0260_SoundBlasterOld_sf2','0260_Stratocaster_sf2_file',
      '0261_GeneralUserGS_sf2_file','0261_SoundBlasterOld_sf2',
      '0261_Stratocaster_sf2_file','0262_Stratocaster_sf2_file']},
    { p:'cln', name:'Clean Electric', cat:'guitar', g:0.92, d:0.95, items:[
      '0270_Aspirin_sf2_file','0270_Chaos_sf2_file','0270_FluidR3_GM_sf2_file',
      '0270_GeneralUserGS_sf2_file','0270_Gibson_Les_Paul_sf2_file','0270_JCLive_sf2_file',
      '0270_SBAWE32_sf2_file','0270_SBLive_sf2','0270_SoundBlasterOld_sf2',
      '0270_Stratocaster_sf2_file',
      '0271_GeneralUserGS_sf2_file','0271_Stratocaster_sf2_file','0272_Stratocaster_sf2_file']},
    { p:'mut', name:'Muted Electric', cat:'guitar', g:0.88, d:0.82, items:[
      '0280_Aspirin_sf2_file','0280_Chaos_sf2_file','0280_FluidR3_GM_sf2_file',
      '0280_GeneralUserGS_sf2_file','0280_JCLive_sf2_file',
      '0280_LesPaul_sf2','0280_LesPaul_sf2_file',
      '0280_SBAWE32_sf2_file','0280_SBLive_sf2','0280_SoundBlasterOld_sf2',
      '0281_Aspirin_sf2_file','0281_FluidR3_GM_sf2_file','0281_GeneralUserGS_sf2_file',
      '0282_FluidR3_GM_sf2_file','0282_GeneralUserGS_sf2_file',
      '0283_GeneralUserGS_sf2_file']},
    { p:'ovr', name:'Overdriven Guitar', cat:'guitar', g:0.94, d:0.92, items:[
      '0290_Aspirin_sf2_file','0290_Chaos_sf2_file','0290_FluidR3_GM_sf2_file',
      '0290_GeneralUserGS_sf2_file','0290_JCLive_sf2_file',
      '0290_LesPaul_sf2','0290_LesPaul_sf2_file',
      '0290_SBAWE32_sf2_file','0290_SBLive_sf2','0290_SoundBlasterOld_sf2',
      '0291_Aspirin_sf2_file','0291_LesPaul_sf2','0291_LesPaul_sf2_file',
      '0291_SBAWE32_sf2_file','0291_SoundBlasterOld_sf2',
      '0292_Aspirin_sf2_file','0292_LesPaul_sf2','0292_LesPaul_sf2_file']},
    { p:'dst', name:'Distortion Guitar', cat:'guitar', g:0.97, d:0.9, items:[
      '0300_Aspirin_sf2_file','0300_Chaos_sf2_file','0300_FluidR3_GM_sf2_file',
      '0300_GeneralUserGS_sf2_file','0300_JCLive_sf2_file',
      '0300_LesPaul_sf2','0300_LesPaul_sf2_file',
      '0300_SBAWE32_sf2_file','0300_SBLive_sf2','0300_SoundBlasterOld_sf2',
      '0301_Aspirin_sf2_file','0301_FluidR3_GM_sf2_file','0301_GeneralUserGS_sf2_file',
      '0301_JCLive_sf2_file','0301_LesPaul_sf2','0301_LesPaul_sf2_file',
      '0302_Aspirin_sf2_file','0302_GeneralUserGS_sf2_file','0302_JCLive_sf2_file',
      '0303_Aspirin_sf2_file','0304_Aspirin_sf2_file']},
    { p:'harm', name:'Guitar Harmonics', cat:'guitar', g:0.85, d:0.8, items:[
      '0310_Aspirin_sf2_file','0310_Chaos_sf2_file','0310_FluidR3_GM_sf2_file',
      '0310_GeneralUserGS_sf2_file','0310_JCLive_sf2_file',
      '0310_LesPaul_sf2','0310_LesPaul_sf2_file',
      '0310_SBAWE32_sf2_file','0310_SBLive_sf2','0310_SoundBlasterOld_sf2',
      '0311_FluidR3_GM_sf2_file','0311_GeneralUserGS_sf2_file']},
    /* ── Bass ── */
    { p:'ab', name:'Acoustic Bass', cat:'bass', g:0.76, d:1.2, ps:-12, bo:true, items:[
      '0320_Aspirin_sf2_file','0320_Chaos_sf2_file','0320_FluidR3_GM_sf2_file',
      '0320_GeneralUserGS_sf2_file','0320_JCLive_sf2_file',
      '0320_SBLive_sf2','0320_SoundBlasterOld_sf2',
      '0321_GeneralUserGS_sf2_file','0322_GeneralUserGS_sf2_file']},
    { p:'bf', name:'Bass (finger)', cat:'bass', g:0.8, d:1.16, ps:-12, bo:true, items:[
      '0330_Aspirin_sf2_file','0330_Chaos_sf2_file','0330_FluidR3_GM_sf2_file',
      '0330_GeneralUserGS_sf2_file','0330_JCLive_sf2_file',
      '0330_SBLive_sf2','0330_SoundBlasterOld_sf2',
      '0331_GeneralUserGS_sf2_file','0332_GeneralUserGS_sf2_file']},
    { p:'bp', name:'Bass (pick)', cat:'bass', g:0.82, d:1.14, ps:-12, bo:true, items:[
      '0340_Aspirin_sf2_file','0340_Chaos_sf2_file','0340_FluidR3_GM_sf2_file',
      '0340_GeneralUserGS_sf2_file','0340_JCLive_sf2_file',
      '0340_SBLive_sf2','0340_SoundBlasterOld_sf2',
      '0341_Aspirin_sf2_file','0341_GeneralUserGS_sf2_file']},
    { p:'fl', name:'Fretless Bass', cat:'bass', g:0.78, d:1.2, ps:-12, bo:true, items:[
      '0350_Aspirin_sf2_file','0350_Chaos_sf2_file','0350_FluidR3_GM_sf2_file',
      '0350_GeneralUserGS_sf2_file','0350_JCLive_sf2_file',
      '0350_SBLive_sf2','0350_SoundBlasterOld_sf2',
      '0351_GeneralUserGS_sf2_file']},
    { p:'s1', name:'Slap Bass 1', cat:'bass', g:0.84, d:1.08, ps:-12, bo:true, items:[
      '0360_Aspirin_sf2_file','0360_Chaos_sf2_file','0360_FluidR3_GM_sf2_file',
      '0360_GeneralUserGS_sf2_file','0360_JCLive_sf2_file',
      '0360_SBLive_sf2','0360_SoundBlasterOld_sf2',
      '0361_GeneralUserGS_sf2_file']},
    { p:'s2', name:'Slap Bass 2', cat:'bass', g:0.84, d:1.08, ps:-12, bo:true, items:[
      '0370_Aspirin_sf2_file','0370_Chaos_sf2_file','0370_FluidR3_GM_sf2_file',
      '0370_GeneralUserGS_sf2_file','0370_JCLive_sf2_file',
      '0370_SBLive_sf2','0370_SoundBlasterOld_sf2',
      '0371_GeneralUserGS_sf2_file','0372_GeneralUserGS_sf2_file']},
    { p:'y1', name:'Synth Bass 1', cat:'bass', g:0.78, d:1.1, ps:-12, bo:true, items:[
      '0380_Aspirin_sf2_file','0380_Chaos_sf2_file','0380_FluidR3_GM_sf2_file',
      '0380_GeneralUserGS_sf2_file','0380_JCLive_sf2_file',
      '0380_SBLive_sf2','0380_SoundBlasterOld_sf2',
      '0381_FluidR3_GM_sf2_file','0381_GeneralUserGS_sf2_file',
      '0382_FluidR3_GM_sf2_file','0382_GeneralUserGS_sf2_file',
      '0383_GeneralUserGS_sf2_file','0384_GeneralUserGS_sf2_file',
      '0385_GeneralUserGS_sf2_file','0386_GeneralUserGS_sf2_file',
      '0387_GeneralUserGS_sf2_file']},
    { p:'y2', name:'Synth Bass 2', cat:'bass', g:0.78, d:1.1, ps:-12, bo:true, items:[
      '0390_Aspirin_sf2_file','0390_Chaos_sf2_file','0390_FluidR3_GM_sf2_file',
      '0390_GeneralUserGS_sf2_file','0390_JCLive_sf2_file',
      '0390_SBLive_sf2','0390_SoundBlasterOld_sf2',
      '0391_FluidR3_GM_sf2_file','0391_GeneralUserGS_sf2_file','0391_SoundBlasterOld_sf2',
      '0392_FluidR3_GM_sf2_file','0392_GeneralUserGS_sf2_file',
      '0393_GeneralUserGS_sf2_file']},
  ];

  CATALOG.forEach(grp => {
    grp.items.forEach(fileId => {
      const m = fileId.match(/^(\d{4})_(.+)$/);
      if (!m) return;
      const pid = m[1], sf = m[2];
      const sc = SF_SHORT[sf] || sf.replace(/[^a-zA-Z0-9]/g,'').toLowerCase().slice(0,6);
      const key = `${grp.p}-${pid}-${sc}`;
      const sfLbl = SF_LABEL[sf] || sf.replace(/_sf2_file$|_sf2$|_SF2_file$/,'').replace(/_/g,' ');
      lib[key] = createWebAudioFontInstrument(pid, `${grp.name} – ${sfLbl} #${pid}`, {
        soundfont: sf,
        shortLabel: `${sfLbl} ${pid}`,
        category: grp.cat,
        group: grp.p,
        mixGain: grp.g,
        pitchShift: grp.ps || 0,
        durationMul: grp.d,
        bassOnly: grp.bo || false,
      });
    });
  });

  /* Legacy aliases (backward compat with saved presets) */
  lib.nylon    = lib['nyl-0240-flu']  || lib[Object.keys(lib).find(k=>k.startsWith('nyl-'))];
  lib.steel    = lib['stl-0250-flu']  || lib[Object.keys(lib).find(k=>k.startsWith('stl-'))];
  lib.electric = lib['cln-0270-flu']  || lib[Object.keys(lib).find(k=>k.startsWith('cln-'))];
  lib.bass     = lib['bf-0330-flu']   || lib[Object.keys(lib).find(k=>k.startsWith('bf-'))];

  return lib;
})();

const ALLOWED_INSTRUMENT_TYPES = Object.keys(INSTRUMENT_LIBRARY);
const ALLOWED_INSTRUMENT_SET = new Set(ALLOWED_INSTRUMENT_TYPES);
const INSTRUMENT_PROGRAM_MAP = Object.create(null);
ALLOWED_INSTRUMENT_TYPES.forEach(type => {
  const entry = INSTRUMENT_LIBRARY[type];
  if (!entry) return;
  const program = entry.program;
  if (Number.isFinite(program) && !INSTRUMENT_PROGRAM_MAP[program]) {
    INSTRUMENT_PROGRAM_MAP[program] = type;
  }
});

function formatAllowedInstruments(limit = 32) {
  if (!Number.isFinite(limit) || limit <= 0 || ALLOWED_INSTRUMENT_TYPES.length <= limit) {
    return ALLOWED_INSTRUMENT_TYPES.join(', ');
  }
  const visible = ALLOWED_INSTRUMENT_TYPES.slice(0, limit).join(', ');
  return `${visible}, ... (+${ALLOWED_INSTRUMENT_TYPES.length - limit} more)`;
}

function normalizeInstrumentType(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-');

  /* ── 1. Static aliases: human-readable names → internal keys ── */
  const aliases = {
    guitar: 'steel',
    acoustic: 'steel',
    'acoustic-guitar': 'steel',
    'acoustic-guitar-nylon': 'nylon',
    'acoustic-guitar-steel': 'steel',
    'acoustic-nylon': 'nylon',
    'acoustic-steel': 'steel',
    'electric-guitar': 'electric',
    'electric-guitar-jazz': 'jazz-0260-flu',
    'electric-guitar-clean': 'electric',
    'electric-guitar-muted': 'mut-0280-flu',
    'overdriven-guitar': 'ovr-0290-flu',
    'distortion-guitar': 'dst-0300-flu',
    'guitar-harmonics': 'harm-0310-flu',
    electro: 'electric',
    'electro-guitar': 'electric',
    'bass-guitar': 'bass',
    'acoustic-bass': 'ab-0320-flu',
    'electric-bass-finger': 'bass',
    'electric-bass-pick': 'bp-0340-flu',
    'fretless-bass': 'fl-0350-flu',
    'slap-bass-1': 's1-0360-flu',
    'slap-bass-2': 's2-0370-flu',
    'synth-bass-1': 'y1-0380-flu',
    'synth-bass-2': 'y2-0390-flu',
  };
  const resolved = aliases[raw] || raw;

  /* ── 2. Exact match ── */
  if (ALLOWED_INSTRUMENT_SET.has(resolved)) return resolved;

  /* ── 3. Group-only shortcut: "stl" → first steel, "nyl" → first nylon, etc. ── */
  const groupAliases = {
    nyl: 'nyl', nylon: 'nyl',
    stl: 'stl', steel: 'stl',
    jazz: 'jazz',
    cln: 'cln', clean: 'cln',
    mut: 'mut', muted: 'mut', mute: 'mut',
    ovr: 'ovr', overdrive: 'ovr', overdriven: 'ovr',
    dst: 'dst', distortion: 'dst', dist: 'dst',
    harm: 'harm', harmonics: 'harm',
    ab: 'ab',
    bf: 'bf',
    bp: 'bp',
    fl: 'fl', fretless: 'fl',
    s1: 's1', slap1: 's1',
    s2: 's2', slap2: 's2',
    y1: 'y1', synth1: 'y1',
    y2: 'y2', synth2: 'y2',
  };
  const groupKey = groupAliases[resolved];
  if (groupKey) {
    const firstInGroup = ALLOWED_INSTRUMENT_TYPES.find(k => k.startsWith(groupKey + '-'));
    if (firstInGroup) return firstInGroup;
  }

  /* ── 4. "group-program" without sf suffix: "stl-0250" → first "stl-0250-*" ── */
  const gpMatch = resolved.match(/^([a-z]{1,5})-(\d{3,4})$/);
  if (gpMatch) {
    const prefix = gpMatch[1] + '-' + gpMatch[2] + '-';
    const found = ALLOWED_INSTRUMENT_TYPES.find(k => k.startsWith(prefix));
    if (found) return found;
    // Also try group alias: "steel-0250" → "stl-0250-*"
    const mappedGrp = groupAliases[gpMatch[1]];
    if (mappedGrp && mappedGrp !== gpMatch[1]) {
      const prefix2 = mappedGrp + '-' + gpMatch[2] + '-';
      const found2 = ALLOWED_INSTRUMENT_TYPES.find(k => k.startsWith(prefix2));
      if (found2) return found2;
    }
  }

  /* ── 5. Pure program number: "0250" → first instrument with that program ── */
  const numOnly = resolved.match(/^\d{3,4}$/);
  if (numOnly) {
    const program = parseInt(numOnly[0], 10);
    return INSTRUMENT_PROGRAM_MAP[program] || null;
  }

  /* ── 6. Trailing program with group context: "stl-0250-xyz" partial ── */
  const trailingMatch = resolved.match(/^([a-z]{1,5})-(\d{3,4})-(.+)$/);
  if (trailingMatch) {
    // Full key didn't match exactly (step 2), but try group alias
    const mappedGrp = groupAliases[trailingMatch[1]];
    if (mappedGrp && mappedGrp !== trailingMatch[1]) {
      const altKey = mappedGrp + '-' + trailingMatch[2] + '-' + trailingMatch[3];
      if (ALLOWED_INSTRUMENT_SET.has(altKey)) return altKey;
    }
    // Try same group-program, any soundfont
    const prefix = (mappedGrp || trailingMatch[1]) + '-' + trailingMatch[2] + '-';
    const fallback = ALLOWED_INSTRUMENT_TYPES.find(k => k.startsWith(prefix));
    if (fallback) return fallback;
  }

  /* ── 7. Trailing program number (no group): "guitar-0250" ── */
  const trailingProgram = resolved.match(/(\d{3,4})$/);
  if (trailingProgram) {
    const program = parseInt(trailingProgram[1], 10);
    if (INSTRUMENT_PROGRAM_MAP[program]) return INSTRUMENT_PROGRAM_MAP[program];
  }

  /* ── 8. Partial key match — prefer startsWith over includes ── */
  const prefixMatch = ALLOWED_INSTRUMENT_TYPES.find(k => k.startsWith(resolved));
  if (prefixMatch) return prefixMatch;
  const partial = ALLOWED_INSTRUMENT_TYPES.find(k => k.includes(resolved));
  if (partial) return partial;

  /* ── 9. Soundfont-name match: "aspirin" → first instrument with asp suffix ── */
  const sfMatch = Object.entries(SF_SHORT).find(([full, short]) =>
    resolved === short || full.toLowerCase().replace(/_sf2_file$|_sf2$|_SF2_file$/, '').replace(/_/g, '-').includes(resolved)
  );
  if (sfMatch) {
    const sfShort = sfMatch[1];
    const found = ALLOWED_INSTRUMENT_TYPES.find(k => k.endsWith('-' + sfShort));
    if (found) return found;
  }

  return null;
}

function sanitizeInstrumentList(list, fallback = 'steel') {
  const source = Array.isArray(list)
    ? list
    : (list === undefined || list === null ? [] : [list]);
  const normalized = [];
  source.forEach(item => {
    const value = normalizeInstrumentType(item);
    if (!value) return;
    if (!normalized.includes(value)) normalized.push(value);
  });
  if (!normalized.length) normalized.push(fallback);
  return normalized.slice(0, 4);
}

function getActiveInstrumentList() {
  activeInstruments = sanitizeInstrumentList(activeInstruments, 'steel');
  return activeInstruments;
}

function getInstrumentLabel(type) {
  const safeType = normalizeInstrumentType(type);
  if (!safeType) return String(type || '').trim() || 'Unknown';
  return INSTRUMENT_LIBRARY[safeType].label;
}

function hasAnyLoadedInstrument(types = getActiveInstrumentList()) {
  return types.some(type => Boolean(loadedInstruments[type]));
}

function updateLegacyInstrumentState() {
  const primary = getActiveInstrumentList()[0] || 'steel';
  guitarType = primary;
  currentInstrument = loadedInstruments[primary] || null;
  instrumentLoaded = Boolean(currentInstrument);
}

let _instPickerActiveTab = null;

function renderInstrumentButtons() {
  const container = document.getElementById('instrumentButtons');
  if (!container) return;

  const selected = new Set(getActiveInstrumentList());
  container.innerHTML = '';

  /* Group instruments by their group prefix */
  const groups = new Map();
  ALLOWED_INSTRUMENT_TYPES.forEach(type => {
    const cfg = INSTRUMENT_LIBRARY[type] || {};
    const grp = cfg.group || 'other';
    if (!groups.has(grp)) groups.set(grp, []);
    groups.get(grp).push(type);
  });

  const order = INSTRUMENT_GROUP_ORDER.filter(g => groups.has(g));
  groups.forEach((_, g) => { if (!order.includes(g)) order.push(g); });

  if (!_instPickerActiveTab || !groups.has(_instPickerActiveTab)) {
    _instPickerActiveTab = order.find(g => {
      const items = groups.get(g);
      return items && items.some(t => selected.has(t));
    }) || order[0] || null;
  }

  const picker = document.createElement('div');
  picker.className = 'inst-picker';

  // Header
  const hdr = document.createElement('div');
  hdr.className = 'inst-picker-header';
  const hdrTitle = document.createElement('span');
  hdrTitle.className = 'inst-picker-title';
  hdrTitle.textContent = '\ud83c\udfb8 \u0406\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442\u0438';
  const hdrLayers = document.createElement('span');
  hdrLayers.className = 'inst-picker-layers';
  hdrLayers.innerHTML = `\u0428\u0430\u0440\u0456\u0432: <b>${selected.size}</b>/4`;
  hdr.appendChild(hdrTitle);
  hdr.appendChild(hdrLayers);
  picker.appendChild(hdr);

  // Tabs
  const tabsRow = document.createElement('div');
  tabsRow.className = 'inst-tabs';
  order.forEach(grpKey => {
    const items = groups.get(grpKey);
    if (!items || !items.length) return;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'inst-tab' + (grpKey === _instPickerActiveTab ? ' active' : '');
    const label = (INSTRUMENT_GROUP_LABELS[grpKey] || grpKey).replace(/^[^\\s]+\\s*/, '');
    const hasActive = items.some(t => selected.has(t));
    tab.innerHTML = label + (hasActive ? '<span class="tab-dot"></span>' : '');
    tab.title = INSTRUMENT_GROUP_LABELS[grpKey] || grpKey;
    tab.dataset.grp = grpKey;
    tab.addEventListener('click', () => {
      _instPickerActiveTab = grpKey;
      renderInstrumentButtons();
    });
    tabsRow.appendChild(tab);
  });
  picker.appendChild(tabsRow);

  // Grid
  const grid = document.createElement('div');
  grid.className = 'inst-grid';
  const activeItems = groups.get(_instPickerActiveTab) || [];
  activeItems.forEach(type => {
    const cfg = INSTRUMENT_LIBRARY[type] || {};
    const isSelected = selected.has(type);
    const item = document.createElement('div');
    item.className = 'inst-item' + (isSelected ? ' selected' : '');
    item.dataset.inst = type;
    item.title = `${cfg.label || type}\n[${type}]`;

    const check = document.createElement('span');
    check.className = 'inst-item-check';
    check.textContent = '\u2713';

    const lbl = document.createElement('span');
    lbl.className = 'inst-item-label';
    const sfOnly = (cfg.shortLabel || type).replace(/\s*\d{4}$/, '');
    lbl.textContent = sfOnly;

    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'inst-item-preview';
    preview.textContent = '\u266a';
    preview.title = '\u041f\u0440\u043e\u0441\u043b\u0443\u0445\u0430\u0442\u0438';
    preview.addEventListener('click', (e) => {
      e.stopPropagation();
      previewInstrumentSound(type);
    });

    item.appendChild(check);
    item.appendChild(lbl);
    item.appendChild(preview);
    item.addEventListener('click', () => {
      toggleInstrumentSelection(type);
    });
    grid.appendChild(item);
  });
  picker.appendChild(grid);

  // Active layers strip
  const strip = document.createElement('div');
  strip.className = 'inst-layers-strip';
  if (selected.size === 0) {
    const empty = document.createElement('span');
    empty.className = 'inst-layers-empty';
    empty.textContent = '\u0414\u043e\u0434\u0430\u0439 \u0456\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442';
    strip.appendChild(empty);
  } else {
    selected.forEach(type => {
      const cfg = INSTRUMENT_LIBRARY[type] || {};
      const tag = document.createElement('span');
      tag.className = 'inst-layer-tag';
      const sfOnly = (cfg.shortLabel || type).replace(/\s*\d{4}$/, '');
      const groupLabel = (INSTRUMENT_GROUP_LABELS[cfg.group] || '').replace(/^[^\\s]+\\s*/, '');
      tag.innerHTML = `${groupLabel ? groupLabel + ': ' : ''}${sfOnly}`;
      if (selected.size > 1) {
        const rm = document.createElement('span');
        rm.className = 'tag-remove';
        rm.textContent = '\u2715';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleInstrumentSelection(type);
        });
        tag.appendChild(rm);
      }
      strip.appendChild(tag);
    });
  }
  picker.appendChild(strip);

  container.appendChild(picker);
}

function previewInstrumentSound(type) {
  if (!ctx) initAudio();
  const cfg = INSTRUMENT_LIBRARY[type];
  if (!cfg) return;
  const pitches = [48, 52, 55, 60];
  const inst = loadedInstruments[type];
  if (inst && wafPlayer) {
    pitches.forEach((p, i) => {
      setTimeout(() => {
        try {
          wafPlayer.queueWaveTable(ctx, ctx.destination, inst, ctx.currentTime, p, 0.4, 0.25 * (cfg.mixGain || 0.9));
        } catch(e) {}
      }, i * 60);
    });
  } else {
    flashStatus('\u0421\u0435\u043c\u043f\u043b \u0437\u0430\u0432\u0430\u043d\u0442\u0430\u0436\u0443\u0454\u0442\u044c\u0441\u044f...', 1200);
    loadInstrument(type).then(() => previewInstrumentSound(type));
  }
}

function updateInstrumentButtonsUI() {
  renderInstrumentButtons();
}

function setActiveInstruments(list, options = {}) {
  const { quiet = false } = options;
  activeInstruments = sanitizeInstrumentList(list, 'steel');
  updateLegacyInstrumentState();
  updateInstrumentButtonsUI();
  const selected = getActiveInstrumentList();
  if (!quiet) {
    const title = selected.map(getInstrumentLabel).join(' + ');
    setInfoText(`Instruments: ${title}`, true);
  }
  if (ctx && wafPlayer) loadSelectedInstruments();
}

function toggleInstrumentSelection(type) {
  const safeType = normalizeInstrumentType(type);
  if (!safeType) return;

  const selected = getActiveInstrumentList();
  if (selected.includes(safeType)) {
    if (selected.length === 1) {
      flashStatus('At least 1 instrument must stay active', 1600);
      return;
    }
    setActiveInstruments(selected.filter(item => item !== safeType));
    return;
  }

  if (selected.length >= 4) {
    flashStatus('Maximum 4 instrument layers', 1600);
    return;
  }

  setActiveInstruments([...selected, safeType]);
}

function setInfoText(msg, ok = false) {
  const el = document.getElementById('soundEngineInfo');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? 'var(--amber-bright)' : 'var(--fret)';
}

async function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') await ctx.resume();
    if (wafPlayer && !hasAnyLoadedInstrument()) return loadSelectedInstruments();
    return hasAnyLoadedInstrument();
  }

  ctx = new AudioContext();

  dryGain = ctx.createGain();
  dryGain.gain.value = 1;

  bodyHighPass = ctx.createBiquadFilter();
  bodyHighPass.type = 'highpass';
  bodyHighPass.frequency.value = 80;    // cut rumble below 80Hz
  bodyHighPass.Q.value = 0.55;

  bodyPeak = ctx.createBiquadFilter();
  bodyPeak.type = 'peaking';
  bodyPeak.frequency.value = 250;       // body warmth — gentle, not muddy
  bodyPeak.gain.value = 1.2;            // was 2.6 — too boosted = mud
  bodyPeak.Q.value = 1.1;

  // NEW: presence boost — adds pick attack clarity ("air" on guitar)
  let bodyPresence;
  bodyPresence = ctx.createBiquadFilter();
  bodyPresence.type = 'peaking';
  bodyPresence.frequency.value = 2800;  // guitar string presence freq
  bodyPresence.gain.value = 1.4;
  bodyPresence.Q.value = 0.9;

  bodyLowPass = ctx.createBiquadFilter();
  bodyLowPass.type = 'lowpass';
  bodyLowPass.frequency.value = 8200;   // trim harsh top-end while keeping pick clarity
  bodyLowPass.Q.value = 0.65;

  bodyCompressor = ctx.createDynamicsCompressor();
  bodyCompressor.threshold.value = -18; // slightly lower threshold for more consistent level
  bodyCompressor.knee.value = 12;
  bodyCompressor.ratio.value = 2.5;
  bodyCompressor.attack.value = 0.003;  // faster attack catches transients
  bodyCompressor.release.value = 0.22;

  masterGain = ctx.createGain();
  masterGain.gain.value = volume;
  masterGain.connect(ctx.destination);

  dryGain.connect(bodyHighPass);
  bodyHighPass.connect(bodyPeak);
  bodyPeak.connect(bodyPresence);
  bodyPresence.connect(bodyLowPass);
  bodyLowPass.connect(bodyCompressor);
  bodyCompressor.connect(masterGain);

  // Bass instrument bus: separate lowpass + compressor for clean low-end
  bassLowPass = ctx.createBiquadFilter();
  bassLowPass.type = 'lowpass';
  bassLowPass.frequency.value = 280;
  bassLowPass.Q.value = 0.7;

  bassCompressor = ctx.createDynamicsCompressor();
  bassCompressor.threshold.value = -22;
  bassCompressor.knee.value = 10;
  bassCompressor.ratio.value = 3.5;
  bassCompressor.attack.value = 0.004;
  bassCompressor.release.value = 0.18;

  bassBusGain = ctx.createGain();
  bassBusGain.gain.value = 0.82;

  bassLowPass.connect(bassCompressor);
  bassCompressor.connect(bassBusGain);
  bassBusGain.connect(masterGain);

  if (typeof WebAudioFontPlayer === 'function') {
    wafPlayer = new WebAudioFontPlayer();
    try {
      wafReverb = new WebAudioFontReverberator(ctx);
      reverbFilter = ctx.createBiquadFilter();
      reverbFilter.type = 'lowpass';      // was bandpass — caused metallic ring
      reverbFilter.frequency.value = 3800; // roll off harsh reverb highs
      reverbFilter.Q.value = 0.5;
      reverbGain = ctx.createGain();
      reverbGain.gain.value = 0.16;       // was 0.12 — slightly more room
      wafReverb.output.connect(reverbFilter);
      reverbFilter.connect(reverbGain);
      reverbGain.connect(bodyCompressor);
    } catch (err) {
      wafReverb = null;
      reverbGain = null;
      reverbFilter = null;
    }
    return loadSelectedInstruments();
  }

  setInfoText('⚠ WebAudioFont недоступний, увімкнено fallback');
  return false;
}

function applyFastAttackToPreset(preset, instrumentType = null) {
  if (!preset || typeof preset !== 'object' || !Array.isArray(preset.zones)) return;
  preset.zones.forEach(zone => {
    if (!zone || typeof zone !== 'object') return;
    // Only modify zones that already have a properly formatted ahdsr array
    if (!Array.isArray(zone.ahdsr) || zone.ahdsr.length === 0) return;
    // WebAudioFont AHDSR format: [{duration, volume}, ...]
    // Stage 0 = Attack, Stage 2 = Decay
    const attackStage = zone.ahdsr[0];
    if (attackStage && typeof attackStage === 'object' && Number.isFinite(attackStage.duration)) {
      attackStage.duration = Math.min(attackStage.duration, 0.002);
    }
    if (instrumentType === 'electric' && zone.ahdsr.length > 2) {
      const decayStage = zone.ahdsr[2];
      if (decayStage && typeof decayStage === 'object' && Number.isFinite(decayStage.duration)) {
        decayStage.duration = Math.min(decayStage.duration, 0.2);
      }
    }
  });
}

function loadInstrument(type) {
  if (!ctx || !wafPlayer) return Promise.resolve(false);
  const safeType = normalizeInstrumentType(type) || 'steel';
  const cfg = INSTRUMENT_LIBRARY[safeType];
  if (!cfg) return Promise.resolve(false);

  if (loadedInstruments[safeType]) return Promise.resolve(true);
  if (instrumentLoadPromises[safeType]) return instrumentLoadPromises[safeType];

  setInfoText(`Loading ${cfg.label}...`);

  instrumentLoadPromises[safeType] = new Promise(resolve => {
    const finalizeLoad = () => {
      loadedInstruments[safeType] = window[cfg.varName] || null;
      if (loadedInstruments[safeType] && wafPlayer && wafPlayer.loader && typeof wafPlayer.loader.decodeAfterLoading === 'function') {
        try {
          wafPlayer.loader.decodeAfterLoading(ctx, cfg.varName);
        } catch (err) {
          // ignore decode hook issues
        }
      }
      applyFastAttackToPreset(loadedInstruments[safeType], safeType);
      updateLegacyInstrumentState();
      delete instrumentLoadPromises[safeType];
      resolve(Boolean(loadedInstruments[safeType]));
    };

    if (window[cfg.varName]) {
      wafPlayer.loader.decodeAfterLoading(ctx, cfg.varName);
      wafPlayer.loader.waitLoad(finalizeLoad);
      return;
    }

    wafPlayer.loader.startLoad(ctx, cfg.url, cfg.varName);
    wafPlayer.loader.waitLoad(finalizeLoad);
  });

  return instrumentLoadPromises[safeType];
}

async function loadSelectedInstruments() {
  if (!ctx || !wafPlayer) return false;
  const selected = getActiveInstrumentList();
  if (!selected.length) return false;

  // Also load instruments from all tracks
  const trackInsts = tracks.flatMap(t => t.instruments);
  const allInsts = [...new Set([...selected, ...trackInsts])];

  const results = await Promise.all(allInsts.map(type => loadInstrument(type)));
  updateLegacyInstrumentState();

  const loadedCount = results.filter(Boolean).length;
  const title = selected.map(getInstrumentLabel).join(' + ');
  if (loadedCount > 0) {
    const nativeHint = USE_WAF_NATIVE_CHORD_API && selected.length === 1
      ? ' | native chord API on'
      : '';
    setInfoText(`Layers: ${title} (${loadedCount}/${allInsts.length})${nativeHint}`, true);
  } else {
    setInfoText('⚠ Не вдалося завантажити семпли, увімкнено fallback');
  }
  return loadedCount > 0;
}

async function waitForInstrumentLoad(timeoutMs = 1800) {
  if (!wafPlayer) return false;
  if (hasAnyLoadedInstrument()) return true;
  const pendingLoads = Object.values(instrumentLoadPromises);
  const loadPromise = pendingLoads.length
    ? Promise.all(pendingLoads).then(() => hasAnyLoadedInstrument())
    : loadSelectedInstruments();
  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(false), timeoutMs));
  return Promise.race([loadPromise, timeoutPromise]);
}

function switchGuitar(type) {
  const safeType = normalizeInstrumentType(type) || 'steel';
  setActiveInstruments([safeType]);
}

function pruneActiveVoices() {
  if (!ctx || !activeVoices.length) return;
  const now = ctx.currentTime;
  activeVoices = activeVoices.filter(voice =>
    !Number.isFinite(voice.expiresAt) || voice.expiresAt > now - 0.05
  );
}

function stopTrackedVoice(voice, releaseSecs = 0.02) {
  if (!voice || typeof voice.stop !== 'function') return;
  try {
    voice.stop(Math.max(0, releaseSecs));
  } catch (err) {
    // ignore stop errors
  }
}

function registerActiveVoice(voice) {
  if (!voice || typeof voice.stop !== 'function') return;
  voice.chordGroupId = currentChordGroupId;
  pruneActiveVoices();
  activeVoices.push(voice);
  while (activeVoices.length > MAX_ACTIVE_VOICES) {
    const oldest = activeVoices.shift();
    stopTrackedVoice(oldest, 0.012);
  }
}

function stopActiveVoices(releaseSecs = 0.025) {
  if (!activeVoices.length) return;
  const voices = activeVoices.splice(0, activeVoices.length);
  voices.forEach(voice => stopTrackedVoice(voice, releaseSecs));
}

// Smart voice stop: only kill voices from previous chord groups (avoids hard-gating reverb tails)
function stopPreviousChordVoices(releaseSecs = 0.025) {
  if (!activeVoices.length) return;
  const threshold = currentChordGroupId - 1;
  const toStop = [];
  activeVoices = activeVoices.filter(voice => {
    if (Number.isFinite(voice.chordGroupId) && voice.chordGroupId <= threshold) {
      toStop.push(voice);
      return false;
    }
    return true;
  });
  toStop.forEach(voice => stopTrackedVoice(voice, releaseSecs));
}

function registerWebAudioFontEnvelopeVoice(envelope, when, duration) {
  if (!envelope) return;
  const envList = Array.isArray(envelope) ? envelope : [envelope];
  envList.forEach(env => {
    if (!env) return;
    registerActiveVoice({
      expiresAt: when + duration + 0.15,
      stop(releaseSecs = 0.02) {
        if (!ctx) return;
        const stopAt = ctx.currentTime + Math.max(0.001, releaseSecs);
        try {
          if (typeof env.cancel === 'function') env.cancel(stopAt);
        } catch (err) {
          // ignore envelope cancel errors
        }
        try {
          const src = env.audioBufferSourceNode || env.source;
          if (src && typeof src.stop === 'function') src.stop(stopAt);
        } catch (err) {
          // ignore source stop errors
        }
      }
    });
  });
}

function canUseNativeWebAudioFontChordApi(mode) {
  if (!USE_WAF_NATIVE_CHORD_API || !wafPlayer || !ctx) return false;
  if (!mode) return false;
  if (![
    'strum-down',
    'strum-up',
    'strum-both',
    'arpeggio',
    'arpeggio-rev',
    'fingerpick',
    'mute',
    'slow-strum',
  ].includes(mode)) return false;
  const selected = getActiveInstrumentList();
  if (selected.length !== 1) return false;
  const preset = loadedInstruments[selected[0]];
  return Boolean(preset);
}

function tryPlayChordNativeWebAudioFont(notes, mode, beatDuration, vel, stepMeta = null) {
  if (!Array.isArray(notes) || !notes.length) return false;
  if (!canUseNativeWebAudioFontChordApi(mode)) return false;

  const selectedType = getActiveInstrumentList()[0];
  const cfg = INSTRUMENT_LIBRARY[selectedType] || INSTRUMENT_LIBRARY.steel;
  const preset = loadedInstruments[selectedType];
  if (!preset) return false;

  const pitches = notes.map(n => clamp((n.pitch || 0) + (cfg.pitchShift || 0), 0, 127));
  if (!pitches.length) return false;

  const when = ctx.currentTime + Math.max(0, getTimingHumanizeMs(stepMeta, 6) / 1000);
  const duration = Math.max(0.05, beatDuration * (cfg.durationMul || 1));
  const baseGain = Math.max(
    0.02,
    Math.min(1, vel * (cfg.mixGain || 1) * getVelocityHumanizeMultiplier(stepMeta, 0.9))
  );
  const spread = getStrumSpreadSeconds(mode, mode === 'strum-up' ? 'up' : 'down', stepMeta);
  const target = dryGain || masterGain;
  let envelope = null;

  try {
    if (mode === 'strum-up' && typeof wafPlayer.queueStrumUp === 'function') {
      envelope = wafPlayer.queueStrumUp(ctx, target, preset, when, pitches, duration, baseGain, spread);
    } else if ((mode === 'strum-down' || mode === 'slow-strum') && typeof wafPlayer.queueStrumDown === 'function') {
      envelope = wafPlayer.queueStrumDown(ctx, target, preset, when, pitches, duration * (mode === 'slow-strum' ? 1.12 : 1), baseGain, spread);
    } else if (mode === 'strum-both' && typeof wafPlayer.queueStrumDown === 'function' && typeof wafPlayer.queueStrumUp === 'function') {
      const first = wafPlayer.queueStrumDown(ctx, target, preset, when, pitches, duration, baseGain * 0.92, spread);
      const upWhen = when + Math.max(0.08, duration * 0.46);
      const second = wafPlayer.queueStrumUp(ctx, target, preset, upWhen, pitches, Math.max(0.05, duration * 0.55), baseGain * 0.62, spread * 0.9);
      envelope = [first, second];
    } else if (mode === 'mute' && typeof wafPlayer.queueSnap === 'function') {
      envelope = wafPlayer.queueSnap(ctx, target, preset, when, pitches, Math.max(0.04, duration * 0.3), baseGain * 0.86, spread * 0.65);
    } else if (
      (mode === 'arpeggio' || mode === 'arpeggio-rev' || mode === 'fingerpick')
      && typeof wafPlayer.queueChord === 'function'
    ) {
      const ordered = mode === 'arpeggio-rev' ? [...pitches].reverse() : [...pitches];
      envelope = wafPlayer.queueChord(ctx, target, preset, when, ordered, Math.max(0.05, duration * 0.92), baseGain * 0.95, Math.max(0.006, spread * 0.75));
    } else if (typeof wafPlayer.queueChord === 'function') {
      envelope = wafPlayer.queueChord(ctx, target, preset, when, pitches, duration, baseGain, spread);
    } else {
      return false;
    }

    registerWebAudioFontEnvelopeVoice(envelope, when, duration);

    if (wafReverb && typeof wafPlayer.queueChord === 'function' && mode !== 'mute') {
      try {
        const reverbPitches = mode === 'arpeggio-rev' ? [...pitches].reverse() : pitches;
        wafPlayer.queueChord(
          ctx,
          wafReverb.input,
          preset,
          when + 0.004,
          reverbPitches,
          Math.max(0.05, duration * 0.7),
          baseGain * 0.11,
          Math.max(0.004, spread * 0.8)
        );
      } catch (err) {
        // ignore reverb send issues
      }
    }

    return true;
  } catch (err) {
    return false;
  }
}

function playNoteFallback(freq, time, duration, gainVal) {
  if (!ctx) return null;
  const t = ctx.currentTime + Math.max(0, time);
  const dur = Math.max(0.045, duration * (0.86 + Math.random() * 0.2));

  // Guitar-like: fundamental + octave + 5th harmonic + percussive noise
  const osc1 = ctx.createOscillator();  // fundamental
  const osc2 = ctx.createOscillator();  // octave
  const osc3 = ctx.createOscillator();  // 5th harmonic (adds warmth)
  const noise = ctx.createBufferSource();
  const env = ctx.createGain();
  const env2 = ctx.createGain();
  const env3 = ctx.createGain();
  const noiseGain = ctx.createGain();
  const noiseFilter = ctx.createBiquadFilter();

  const noiseLen = Math.max(8, Math.floor(ctx.sampleRate * 0.012));
  const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseLen; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
  noise.buffer = noiseBuf;

  osc1.type = 'triangle';
  osc2.type = 'triangle';
  osc3.type = 'sine';
  osc1.frequency.value = freq;
  osc2.frequency.value = freq * 2.0;
  osc3.frequency.value = freq * 3.0;

  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = 3200;
  noiseFilter.Q.value = 1.0;

  // Main envelope: fast attack, pluck-style decay
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gainVal * 0.85, t + 0.003);
  env.gain.exponentialRampToValueAtTime(Math.max(gainVal * 0.38, 0.001), t + 0.06);
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);

  // Octave: quieter, decays faster
  env2.gain.setValueAtTime(0, t);
  env2.gain.linearRampToValueAtTime(gainVal * 0.28, t + 0.003);
  env2.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.55);

  // 5th harmonic: very quiet, quick decay
  env3.gain.setValueAtTime(0, t);
  env3.gain.linearRampToValueAtTime(gainVal * 0.10, t + 0.003);
  env3.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.28);

  // Pick noise
  noiseGain.gain.setValueAtTime(gainVal * 0.18, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.018);

  osc1.connect(env);
  osc2.connect(env2);
  osc3.connect(env3);
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);

  const out = dryGain || masterGain;
  env.connect(out);
  env2.connect(out);
  env3.connect(out);
  noiseGain.connect(out);

  osc1.start(t); osc1.stop(t + dur + 0.05);
  osc2.start(t); osc2.stop(t + dur * 0.6);
  osc3.start(t); osc3.stop(t + dur * 0.35);
  noise.start(t); noise.stop(t + 0.025);

  return {
    expiresAt: t + dur + 0.08,
    stop(releaseSecs = 0.02) {
      if (!ctx) return;
      const now = ctx.currentTime;
      const stopAt = now + Math.max(0.001, releaseSecs);
      [env, env2, env3, noiseGain].forEach(g => {
        try {
          g.gain.cancelScheduledValues(now);
          const current = Math.max(0.0001, g.gain.value || 0.0001);
          g.gain.setValueAtTime(current, now);
          g.gain.exponentialRampToValueAtTime(0.0001, stopAt);
        } catch (err) {
          // ignore envelope stop errors
        }
      });
      [osc1, osc2, osc3, noise].forEach(src => {
        try {
          src.stop(stopAt + 0.01);
        } catch (err) {
          // ignore source stop errors
        }
      });
    }
  };
}

// ===================== CHORD DATA =====================
const CHORDS = {
  // ===================== МАЖОРНІ АКОРДИ =====================
  // notes: [{f:fret, s:string}] де s: 0=1-а(тонка E), 5=6-а(товста E)
  // midi: [6th,5th,4th,3rd,2nd,1st] низ->верх. -1 = не граємо
  // Всі аплікатури перевірені за стандартним строєм EADGBE (40,45,50,55,59,64)
  'C':   { name:'C',   notes:[{f:3,s:4},{f:2,s:3},{f:0,s:2},{f:1,s:1},{f:0,s:0}], midi:[-1,48,52,55,60,64], freqs:[], label:'C' },
  'D':   { name:'D',   notes:[{f:0,s:3},{f:2,s:2},{f:3,s:1},{f:2,s:0}], midi:[-1,-1,50,57,62,66], freqs:[], label:'D' },
  'E':   { name:'E',   notes:[{f:0,s:5},{f:2,s:4},{f:2,s:3},{f:1,s:2},{f:0,s:1},{f:0,s:0}], midi:[40,47,52,56,59,64], freqs:[], label:'E' },
  'F':   { name:'F',   notes:[{f:1,s:5},{f:3,s:4},{f:3,s:3},{f:2,s:2},{f:1,s:1},{f:1,s:0}], midi:[41,48,53,57,60,65], freqs:[], label:'F' },
  'G':   { name:'G',   notes:[{f:3,s:5},{f:2,s:4},{f:0,s:3},{f:0,s:2},{f:0,s:1},{f:3,s:0}], midi:[43,47,50,55,59,67], freqs:[], label:'G' },
  'A':   { name:'A',   notes:[{f:0,s:4},{f:2,s:3},{f:2,s:2},{f:2,s:1},{f:0,s:0}], midi:[-1,45,52,57,61,64], freqs:[], label:'A' },
  'B':   { name:'B',   notes:[{f:2,s:4},{f:4,s:3},{f:4,s:2},{f:4,s:1},{f:2,s:0}], midi:[-1,47,54,59,63,66], freqs:[], label:'B' },

  // Дієзи / бемолі мажорні
  'C#':  { name:'C#',  notes:[{f:4,s:4},{f:6,s:3},{f:6,s:2},{f:6,s:1},{f:4,s:0}], midi:[-1,49,56,61,65,68], freqs:[], label:'C#/Db' },
  'Db':  { name:'Db',  notes:[], midi:[-1,49,56,61,65,68], freqs:[], label:'Db' },
  'D#':  { name:'D#',  notes:[], midi:[-1,-1,51,58,63,67], freqs:[], label:'D#/Eb' },
  'Eb':  { name:'Eb',  notes:[{f:1,s:3},{f:3,s:2},{f:4,s:1},{f:3,s:0}], midi:[-1,-1,51,58,63,67], freqs:[], label:'Eb' },
  'F#':  { name:'F#',  notes:[{f:2,s:5},{f:4,s:4},{f:4,s:3},{f:3,s:2},{f:2,s:1},{f:2,s:0}], midi:[42,49,54,58,61,66], freqs:[], label:'F#/Gb' },
  'Gb':  { name:'Gb',  notes:[], midi:[42,49,54,58,61,66], freqs:[], label:'Gb' },
  'G#':  { name:'G#',  notes:[{f:4,s:5},{f:6,s:4},{f:6,s:3},{f:5,s:2},{f:4,s:1},{f:4,s:0}], midi:[44,51,56,60,63,68], freqs:[], label:'G#/Ab' },
  'Ab':  { name:'Ab',  notes:[], midi:[44,51,56,60,63,68], freqs:[], label:'Ab' },
  'A#':  { name:'A#',  notes:[{f:1,s:4},{f:3,s:3},{f:3,s:2},{f:3,s:1},{f:1,s:0}], midi:[-1,46,53,58,62,65], freqs:[], label:'A#/Bb' },
  'Bb':  { name:'Bb',  notes:[{f:1,s:4},{f:3,s:3},{f:3,s:2},{f:3,s:1},{f:1,s:0}], midi:[-1,46,53,58,62,65], freqs:[], label:'Bb' },

  // ===================== МІНОРНІ АКОРДИ =====================
  'Am':  { name:'Am',  notes:[{f:0,s:4},{f:2,s:3},{f:2,s:2},{f:1,s:1},{f:0,s:0}], midi:[-1,45,52,57,60,64], freqs:[], label:'Am' },
  'Bm':  { name:'Bm',  notes:[{f:2,s:4},{f:4,s:3},{f:4,s:2},{f:3,s:1},{f:2,s:0}], midi:[-1,47,54,59,62,66], freqs:[], label:'Bm' },
  'Cm':  { name:'Cm',  notes:[{f:3,s:4},{f:5,s:3},{f:5,s:2},{f:4,s:1},{f:3,s:0}], midi:[-1,48,55,60,63,67], freqs:[], label:'Cm' },
  'C#m': { name:'C#m', notes:[{f:4,s:4},{f:6,s:3},{f:6,s:2},{f:5,s:1},{f:4,s:0}], midi:[-1,49,56,61,64,68], freqs:[], label:'C#m' },
  'Dm':  { name:'Dm',  notes:[{f:0,s:3},{f:2,s:2},{f:3,s:1},{f:1,s:0}], midi:[-1,-1,50,57,62,65], freqs:[], label:'Dm' },
  'D#m': { name:'D#m', notes:[], midi:[-1,-1,51,58,63,66], freqs:[], label:'D#m/Ebm' },
  'Ebm': { name:'Ebm', notes:[{f:1,s:3},{f:3,s:2},{f:4,s:1},{f:2,s:0}], midi:[-1,-1,51,58,63,66], freqs:[], label:'Ebm' },
  'Em':  { name:'Em',  notes:[{f:0,s:5},{f:2,s:4},{f:2,s:3},{f:0,s:2},{f:0,s:1},{f:0,s:0}], midi:[40,47,52,55,59,64], freqs:[], label:'Em' },
  'Fm':  { name:'Fm',  notes:[{f:1,s:5},{f:3,s:4},{f:3,s:3},{f:1,s:2},{f:1,s:1},{f:1,s:0}], midi:[41,48,53,56,60,65], freqs:[], label:'Fm' },
  'F#m': { name:'F#m', notes:[{f:2,s:5},{f:4,s:4},{f:4,s:3},{f:2,s:2},{f:2,s:1},{f:2,s:0}], midi:[42,49,54,57,61,66], freqs:[], label:'F#m' },
  'Gm':  { name:'Gm',  notes:[{f:3,s:5},{f:5,s:4},{f:5,s:3},{f:3,s:2},{f:3,s:1},{f:3,s:0}], midi:[43,50,55,58,62,67], freqs:[], label:'Gm' },
  'G#m': { name:'G#m', notes:[{f:4,s:5},{f:6,s:4},{f:6,s:3},{f:4,s:2},{f:4,s:1},{f:4,s:0}], midi:[44,51,56,59,63,68], freqs:[], label:'G#m' },
  'Abm': { name:'Abm', notes:[], midi:[44,51,56,59,63,68], freqs:[], label:'Abm' },
  'A#m': { name:'A#m', notes:[], midi:[-1,46,53,58,61,65], freqs:[], label:'A#m/Bbm' },
  'Bbm': { name:'Bbm', notes:[{f:1,s:4},{f:3,s:3},{f:3,s:2},{f:2,s:1},{f:1,s:0}], midi:[-1,46,53,58,61,65], freqs:[], label:'Bbm' },

  // ===================== ДОМІНАНТСЕПТАКОРДИ (7) =====================
  'A7':  { name:'A7',  notes:[{f:0,s:4},{f:2,s:3},{f:0,s:2},{f:2,s:1},{f:0,s:0}], midi:[-1,45,52,55,61,64], freqs:[], label:'A7' },
  'B7':  { name:'B7',  notes:[{f:2,s:4},{f:1,s:3},{f:2,s:2},{f:0,s:1},{f:2,s:0}], midi:[-1,47,51,57,59,66], freqs:[], label:'B7' },
  'C7':  { name:'C7',  notes:[{f:3,s:4},{f:2,s:3},{f:3,s:2},{f:1,s:1},{f:0,s:0}], midi:[-1,48,52,58,60,64], freqs:[], label:'C7' },
  'D7':  { name:'D7',  notes:[{f:0,s:3},{f:2,s:2},{f:1,s:1},{f:2,s:0}], midi:[-1,-1,50,57,60,66], freqs:[], label:'D7' },
  'E7':  { name:'E7',  notes:[{f:0,s:5},{f:2,s:4},{f:0,s:3},{f:1,s:2},{f:0,s:1},{f:0,s:0}], midi:[40,47,50,56,59,64], freqs:[], label:'E7' },
  'F7':  { name:'F7',  notes:[{f:1,s:5},{f:3,s:4},{f:1,s:3},{f:2,s:2},{f:1,s:1},{f:1,s:0}], midi:[41,48,51,57,60,65], freqs:[], label:'F7' },
  'G7':  { name:'G7',  notes:[{f:3,s:5},{f:2,s:4},{f:0,s:3},{f:0,s:2},{f:0,s:1},{f:1,s:0}], midi:[43,47,50,55,59,65], freqs:[], label:'G7' },

  // ===================== МІНОРНІ СЕПТАКОРДИ (m7) =====================
  'Am7': { name:'Am7', notes:[{f:0,s:4},{f:2,s:3},{f:0,s:2},{f:1,s:1},{f:0,s:0}], midi:[-1,45,52,55,60,64], freqs:[], label:'Am7' },
  'Bm7': { name:'Bm7', notes:[{f:2,s:4},{f:0,s:3},{f:2,s:2},{f:0,s:1},{f:2,s:0}], midi:[-1,47,50,57,59,66], freqs:[], label:'Bm7' },
  'Dm7': { name:'Dm7', notes:[{f:0,s:3},{f:2,s:2},{f:1,s:1},{f:1,s:0}], midi:[-1,-1,50,57,60,65], freqs:[], label:'Dm7' },
  'Em7': { name:'Em7', notes:[{f:0,s:5},{f:2,s:4},{f:0,s:3},{f:0,s:2},{f:0,s:1},{f:0,s:0}], midi:[40,47,50,55,59,64], freqs:[], label:'Em7' },
  'Fm7': { name:'Fm7', notes:[{f:1,s:5},{f:3,s:4},{f:1,s:3},{f:1,s:2},{f:1,s:1},{f:1,s:0}], midi:[41,48,51,56,60,65], freqs:[], label:'Fm7' },
  'Gm7': { name:'Gm7', notes:[{f:3,s:5},{f:5,s:4},{f:3,s:3},{f:3,s:2},{f:3,s:1},{f:3,s:0}], midi:[43,50,53,58,62,67], freqs:[], label:'Gm7' },

  // ===================== МАЖОРНІ СЕПТАКОРДИ (maj7) =====================
  'Cmaj7':{ name:'Cmaj7',notes:[{f:3,s:4},{f:2,s:3},{f:0,s:2},{f:0,s:1},{f:0,s:0}], midi:[-1,48,52,55,59,64], freqs:[], label:'Cmaj7' },
  'Dmaj7':{ name:'Dmaj7',notes:[{f:0,s:3},{f:2,s:2},{f:2,s:1},{f:2,s:0}], midi:[-1,-1,50,57,61,66], freqs:[], label:'Dmaj7' },
  'Emaj7':{ name:'Emaj7',notes:[{f:0,s:5},{f:2,s:4},{f:1,s:3},{f:1,s:2},{f:0,s:1},{f:0,s:0}], midi:[40,47,51,56,59,64], freqs:[], label:'Emaj7' },
  'Fmaj7':{ name:'Fmaj7',notes:[{f:1,s:5},{f:3,s:4},{f:2,s:3},{f:2,s:2},{f:1,s:1},{f:0,s:0}], midi:[41,48,52,57,60,64], freqs:[], label:'Fmaj7' },
  'Gmaj7':{ name:'Gmaj7',notes:[{f:3,s:5},{f:2,s:4},{f:0,s:3},{f:0,s:2},{f:0,s:1},{f:2,s:0}], midi:[43,47,50,55,59,66], freqs:[], label:'Gmaj7' },
  'Amaj7':{ name:'Amaj7',notes:[{f:0,s:4},{f:2,s:3},{f:1,s:2},{f:2,s:1},{f:0,s:0}], midi:[-1,45,52,56,61,64], freqs:[], label:'Amaj7' },

  // ===================== SUS2 =====================
  'Asus2':{ name:'Asus2',notes:[{f:0,s:4},{f:2,s:3},{f:2,s:2},{f:0,s:1},{f:0,s:0}], midi:[-1,45,52,57,59,64], freqs:[], label:'Asus2' },
  'Dsus2':{ name:'Dsus2',notes:[{f:0,s:3},{f:2,s:2},{f:3,s:1},{f:0,s:0}], midi:[-1,-1,50,57,62,64], freqs:[], label:'Dsus2' },
  'Esus2':{ name:'Esus2',notes:[{f:0,s:5},{f:2,s:4},{f:4,s:3},{f:4,s:2},{f:0,s:1},{f:0,s:0}], midi:[40,47,54,59,59,64], freqs:[], label:'Esus2' },
  'Csus2':{ name:'Csus2',notes:[{f:3,s:4},{f:0,s:3},{f:0,s:2},{f:3,s:1},{f:3,s:0}], midi:[-1,48,50,55,62,67], freqs:[], label:'Csus2' },
  'Gsus2':{ name:'Gsus2',notes:[{f:3,s:5},{f:0,s:4},{f:0,s:3},{f:2,s:2},{f:3,s:1},{f:3,s:0}], midi:[43,45,50,57,62,67], freqs:[], label:'Gsus2' },

  // ===================== SUS4 =====================
  'Asus4':{ name:'Asus4',notes:[{f:0,s:4},{f:2,s:3},{f:2,s:2},{f:3,s:1},{f:0,s:0}], midi:[-1,45,52,57,62,64], freqs:[], label:'Asus4' },
  'Dsus4':{ name:'Dsus4',notes:[{f:0,s:3},{f:2,s:2},{f:3,s:1},{f:3,s:0}], midi:[-1,-1,50,57,62,67], freqs:[], label:'Dsus4' },
  'Esus4':{ name:'Esus4',notes:[{f:0,s:5},{f:2,s:4},{f:2,s:3},{f:2,s:2},{f:0,s:1},{f:0,s:0}], midi:[40,47,52,57,59,64], freqs:[], label:'Esus4' },
  'Csus4':{ name:'Csus4',notes:[{f:3,s:4},{f:3,s:3},{f:0,s:2},{f:1,s:1},{f:1,s:0}], midi:[-1,48,53,55,60,65], freqs:[], label:'Csus4' },
  'Gsus4':{ name:'Gsus4',notes:[{f:3,s:5},{f:3,s:4},{f:0,s:3},{f:0,s:2},{f:1,s:1},{f:3,s:0}], midi:[43,48,50,55,60,67], freqs:[], label:'Gsus4' },

  // ===================== ADD9 =====================
  'Cadd9':{ name:'Cadd9',notes:[{f:3,s:4},{f:2,s:3},{f:0,s:2},{f:3,s:1},{f:0,s:0}], midi:[-1,48,52,55,62,64], freqs:[], label:'Cadd9' },
  'Gadd9':{ name:'Gadd9',notes:[{f:3,s:5},{f:2,s:4},{f:0,s:3},{f:2,s:2},{f:0,s:1},{f:3,s:0}], midi:[43,47,50,57,59,67], freqs:[], label:'Gadd9' },
  'Eadd9':{ name:'Eadd9',notes:[{f:0,s:5},{f:2,s:4},{f:2,s:3},{f:1,s:2},{f:0,s:1},{f:2,s:0}], midi:[40,47,52,56,59,66], freqs:[], label:'Eadd9' },
  'Aadd9':{ name:'Aadd9',notes:[{f:0,s:4},{f:2,s:3},{f:4,s:2},{f:2,s:1},{f:0,s:0}], midi:[-1,45,52,59,61,64], freqs:[], label:'Aadd9' },
  'Dadd9':{ name:'Dadd9',notes:[{f:4,s:3},{f:2,s:2},{f:3,s:1},{f:0,s:0}], midi:[-1,-1,54,57,62,64], freqs:[], label:'Dadd9' },

  // ===================== DIM / AUG =====================
  'Bdim': { name:'Bdim', notes:[{f:2,s:4},{f:3,s:3},{f:4,s:2},{f:3,s:1}], midi:[-1,47,53,59,62,-1], freqs:[], label:'Bdim' },
  'C#dim':{ name:'C#dim',notes:[{f:4,s:4},{f:2,s:3},{f:0,s:2},{f:2,s:1},{f:0,s:0}], midi:[-1,49,52,55,61,64], freqs:[], label:'C#dim' },
  'Ddim': { name:'Ddim', notes:[{f:0,s:3},{f:1,s:2},{f:3,s:1},{f:1,s:0}], midi:[-1,-1,50,56,62,65], freqs:[], label:'Ddim' },
  'Fdim': { name:'Fdim', notes:[{f:3,s:3},{f:1,s:2},{f:0,s:1},{f:1,s:0}], midi:[-1,-1,53,56,59,65], freqs:[], label:'Fdim' },
  'Caug': { name:'Caug', notes:[{f:3,s:4},{f:2,s:3},{f:1,s:2},{f:1,s:1},{f:0,s:0}], midi:[-1,48,52,56,60,64], freqs:[], label:'Caug' },
  'Eaug': { name:'Eaug', notes:[{f:0,s:5},{f:3,s:4},{f:2,s:3},{f:1,s:2},{f:1,s:1},{f:0,s:0}], midi:[40,48,52,56,60,64], freqs:[], label:'Eaug' },
  'Gaug': { name:'Gaug', notes:[{f:3,s:5},{f:2,s:4},{f:1,s:3},{f:0,s:2},{f:0,s:1},{f:3,s:0}], midi:[43,47,51,55,59,67], freqs:[], label:'Gaug' },

  // ===================== POWER CHORDS (5) =====================
  'A5':  { name:'A5',  notes:[{f:0,s:4},{f:2,s:3},{f:2,s:2}], midi:[-1,45,52,57,-1,-1], freqs:[], label:'A5' },
  'B5':  { name:'B5',  notes:[{f:2,s:4},{f:4,s:3},{f:4,s:2}], midi:[-1,47,54,59,-1,-1], freqs:[], label:'B5' },
  'C5':  { name:'C5',  notes:[{f:3,s:4},{f:5,s:3},{f:5,s:2}], midi:[-1,48,55,60,-1,-1], freqs:[], label:'C5' },
  'D5':  { name:'D5',  notes:[{f:0,s:3},{f:2,s:2},{f:3,s:1}], midi:[-1,-1,50,57,62,-1], freqs:[], label:'D5' },
  'E5':  { name:'E5',  notes:[{f:0,s:5},{f:2,s:4},{f:2,s:3}], midi:[40,47,52,-1,-1,-1], freqs:[], label:'E5' },
  'F5':  { name:'F5',  notes:[{f:1,s:5},{f:3,s:4},{f:3,s:3}], midi:[41,48,53,-1,-1,-1], freqs:[], label:'F5' },
  'Gb5': { name:'Gb5', notes:[{f:2,s:5},{f:4,s:4},{f:4,s:3}], midi:[42,49,54,-1,-1,-1], freqs:[], label:'Gb5' },
  'G5':  { name:'G5',  notes:[{f:3,s:5},{f:5,s:4},{f:5,s:3}], midi:[43,50,55,-1,-1,-1], freqs:[], label:'G5' },
  'Ab5': { name:'Ab5', notes:[{f:4,s:5},{f:6,s:4},{f:6,s:3}], midi:[44,51,56,-1,-1,-1], freqs:[], label:'Ab5' },
  'Bb5': { name:'Bb5', notes:[{f:6,s:5},{f:8,s:4},{f:8,s:3}], midi:[46,53,58,-1,-1,-1], freqs:[], label:'Bb5' },
  'Db5': { name:'Db5', notes:[{f:4,s:4},{f:6,s:3},{f:6,s:2}], midi:[-1,49,56,61,-1,-1], freqs:[], label:'Db5' },
  'Eb5': { name:'Eb5', notes:[{f:6,s:4},{f:8,s:3},{f:8,s:2}], midi:[-1,51,58,63,-1,-1], freqs:[], label:'Eb5' },

  // ===================== ПАУЗА =====================
  '—':  { name:'—', notes:[], midi:[], freqs:[], label:'—' },
};

const CHORD_NAMES = [
  // Мажорні
  'C','C#','D','D#','Eb','E','F','F#','G','G#','Ab','A','A#','Bb','B',
  // Мінорні
  'Am','Bbm','Bm','Cm','C#m','Dm','D#m','Ebm','Em','Fm','F#m','Gm','G#m','Abm','A#m',
  // Домінантсептакорди
  'A7','B7','C7','D7','E7','F7','G7',
  // Мінорні септакорди
  'Am7','Bm7','Dm7','Em7','Fm7','Gm7',
  // Мажорні септакорди
  'Amaj7','Cmaj7','Dmaj7','Emaj7','Fmaj7','Gmaj7',
  // Sus2
  'Asus2','Csus2','Dsus2','Esus2','Gsus2',
  // Sus4
  'Asus4','Csus4','Dsus4','Esus4','Gsus4',
  // Add9
  'Aadd9','Cadd9','Dadd9','Eadd9','Gadd9',
  // Dim / Aug
  'Bdim','C#dim','Ddim','Fdim','Caug','Eaug','Gaug',
  // Power chords
  'A5','Bb5','B5','C5','Db5','D5','Eb5','E5','F5','Gb5','G5','Ab5',
  // Пауза
  '—',
];
const STRING_NAMES = ['E','B','G','D','A','E'];

// Standard tuning MIDI for open strings (1..6): E4, B3, G3, D3, A2, E2
const OPEN_STRING_MIDI = [64, 59, 55, 50, 45, 40];
const OPEN_STRING_MIDI_LOW_TO_HIGH = [40, 45, 50, 55, 59, 64];

function stringFretToMidi(string1to6, fret) {
  const s = Math.max(1, Math.min(6, Number.isFinite(+string1to6) ? +string1to6 : 2));
  const sIdx = s - 1;
  const f = Number.isFinite(+fret) ? Math.max(0, Math.round(+fret)) : 0;
  return OPEN_STRING_MIDI[sIdx] + f;
}

function getBaseNoteForString(stringNumber) {
  const s = Math.max(1, Math.min(6, Number.isFinite(+stringNumber) ? +stringNumber : 1));
  return OPEN_STRING_MIDI[s - 1];
}

// Автогенерація додаткових акордів шляхом транспонування існуючих
// (чистка: видаляємо дублі, бо всі акорди тепер визначені вище вручну)
(function addAutoChords(){
  // Нічого додавати не треба — всі акорди вже є в CHORDS
  // Перевіряємо, що всі CHORD_NAMES є в CHORDS
  CHORD_NAMES.forEach(name => {
    if (!CHORDS[name]) {
      // Fallback: створюємо синтетичний
      createSyntheticChord(name);
    }
  });
})();

function normalizeChordMidiFromShape(notes) {
  const midi = [-1, -1, -1, -1, -1, -1];
  if (!Array.isArray(notes)) return midi;

  notes.forEach(note => {
    if (!note || typeof note !== 'object') return;
    if (!Number.isFinite(note.s) || !Number.isFinite(note.f)) return;
    const stringIndexHighToLow = Math.max(0, Math.min(5, Math.round(note.s)));
    const lowToHighIndex = 5 - stringIndexHighToLow;
    const fret = Math.max(0, Math.round(note.f));
    midi[lowToHighIndex] = OPEN_STRING_MIDI_LOW_TO_HIGH[lowToHighIndex] + fret;
  });
  return midi;
}

function normalizeChordMidiArray(rawMidi = []) {
  return Array.from({ length: 6 }, (_, i) => {
    const v = rawMidi[i];
    if (!Number.isFinite(v)) return -1;
    const rounded = Math.round(v);
    return rounded >= 0 ? rounded : -1;
  });
}

function normalizeChordLibrary() {
  Object.values(CHORDS).forEach(chord => {
    if (!chord || typeof chord !== 'object') return;

    const midi = (Array.isArray(chord.notes) && chord.notes.length)
      ? normalizeChordMidiFromShape(chord.notes)
      : normalizeChordMidiArray(Array.isArray(chord.midi) ? chord.midi : []);

    const freqs = midi.map(m =>
      (typeof m === 'number' && m >= 0)
        ? +((440 * Math.pow(2, (m - 69) / 12)).toFixed(1))
        : 0
    );

    chord.midi = midi;
    chord.freqs = freqs;
  });
}

normalizeChordLibrary();

// Helper: create a simple synthetic chord (triad-based) when an explicit voicing is missing
function createSyntheticChord(name) {
  try {
    const m = name.match(/^([A-G])([#b]?)(m|m7|7|maj7|sus2|sus4|add9|dim|aug|5)?$/i);
    if (!m) return null;
    const root = m[1].toUpperCase();
    const accidental = m[2] || '';
    const suffix = (m[3] || '').toLowerCase();
    const noteKey = root + accidental;
    const semitoneMap = { C:0, 'C#':1, Db:1, D:2, 'D#':3, Eb:3, E:4, F:5, 'F#':6, Gb:6, G:7, 'G#':8, Ab:8, A:9, 'A#':10, Bb:10, B:11 };
    const sem = semitoneMap[noteKey];
    if (sem === undefined) return null;
    const baseOct = 36; // C2 — base octave for guitar chord calculation
    const rootMidi = baseOct + sem;
    let intervals;
    switch (suffix) {
      case 'm':    intervals = [0, 3, 7, 12, 15, 19]; break;
      case '7':    intervals = [0, 7, 10, 16, 19, 22]; break;
      case 'm7':   intervals = [0, 3, 7, 10, 15, 19]; break;
      case 'maj7': intervals = [0, 4, 7, 11, 16, 19]; break;
      case 'sus2': intervals = [0, 2, 7, 12, 14, 19]; break;
      case 'sus4': intervals = [0, 5, 7, 12, 17, 19]; break;
      case 'add9': intervals = [0, 4, 7, 14, 16, 19]; break;
      case 'dim':  intervals = [0, 3, 6, 12, 15, 18]; break;
      case 'aug':  intervals = [0, 4, 8, 12, 16, 20]; break;
      case '5':    intervals = [0, 7, 12, -1, -1, -1]; break;
      default:     intervals = [0, 4, 7, 12, 16, 19]; break; // major
    }
    const midi = intervals.map(i => i >= 0 ? rootMidi + i : -1);
    const freqs = midi.map(mv => (typeof mv === 'number' && mv >= 0) ? midiToFreq(mv) : 0);
    const notes = []; // leave voicing unspecified
    const entry = { name, notes, midi, freqs, label: name };
    CHORDS[name] = entry;
    if (!CHORD_NAMES.includes(name)) CHORD_NAMES.push(name);
    return entry;
  } catch (e) { return null; }
}

const PLAYABLE_CHORDS = CHORD_NAMES.filter(c => c !== '—');
const STORAGE_KEY = 'guitar-programmer-pattern-v1';
const AI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const SCRIPT_VERSION = 1;
const DOT_OVERRIDE_MODES = ['strum-down', 'strum-up', 'arpeggio', 'mute'];
// Расширенный набор режимов (strum / pattern / arpeggio и варианты)
const AVAILABLE_MODES = [
  'strum-down',
  'strum-up',
  'strum-both',
  'arpeggio',
  'arpeggio-rev',
  'arpeggio-slow',
  'arpeggio-wide',
  'fingerpick',
  'mute',
  'slow-strum',
  'pattern-4',
  'pattern-4-mute',
  'pattern-6',
  'pattern-6-mute',
  'pattern-8',
  'pattern-8-mute',
  'pattern-12',
  'pattern-12-mute',
  'pattern-electric-bass',
];
const MIN_STEPS = 2;
const MAX_STEPS = 256;
const PLAY_STYLE_PRESETS = {
  'custom': {
    label: 'Custom',
  },
  'pop-ballad': {
    label: 'Pop Ballad',
    mode: 'strum-both',
    swing: 8,
    velocity: 76,
    humanizeTimeMs: 10,
    humanizeVelPct: 8,
    tightness: 0.85,
    instruments: ['steel', 'nylon'],
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'strum-both',
  },
  'acoustic-pop-8': {
    label: 'Acoustic Pop 8',
    mode: 'pattern-8',
    swing: 6,
    velocity: 80,
    humanizeTimeMs: 10,
    humanizeVelPct: 8,
    tightness: 0.85,
    instruments: ['steel', 'nylon'],
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'pattern-8',
  },
  'rock-open': {
    label: 'Rock Open Chords',
    mode: 'pattern-8',
    swing: 4,
    velocity: 86,
    humanizeTimeMs: 9,
    humanizeVelPct: 8,
    tightness: 0.84,
    instruments: ['electric', 'bass'],
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'pattern-8',
  },
  'rock-heavy-strum': {
    label: 'Rock Heavy Strum',
    mode: 'slow-strum',
    swing: 4,
    velocity: 88,
    humanizeTimeMs: 10,
    humanizeVelPct: 8,
    tightness: 0.84,
    instruments: ['electric', 'bass'],
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'slow-strum',
  },
  'non-stop-punk': {
    label: 'Non Stop Punk',
    mode: 'pattern-8-mute',
    tempo: 155,
    swing: 0,
    velocity: 96,
    humanizeTimeMs: 4,
    humanizeVelPct: 5,
    tightness: 0.95,
    instruments: ['electric', 'bass'],
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'pattern-8',
  },
  'hard-rock': {
    label: 'Hard Rock',
    mode: 'pattern-12',
    swing: 3,
    velocity: 92,
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'pattern-12',
  },
  'metal-chug': {
    label: 'Metal Chug',
    mode: 'pattern-electric-bass',
    swing: 2,
    velocity: 94,
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'pattern-electric-bass',
  },
  'funk-mute': {
    label: 'Funk Mute',
    mode: 'pattern-8-mute',
    swing: 14,
    velocity: 82,
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'pattern-8-mute',
  },
  'reggae-skank': {
    label: 'Reggae Skank',
    mode: 'pattern-4-mute',
    swing: 10,
    velocity: 74,
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'pattern-4-mute',
  },
  'country-travis': {
    label: 'Country Travis',
    mode: 'fingerpick',
    swing: 5,
    velocity: 80,
    pickPattern: '6 3 4 2 5 3 4 1',
    pickBeats: 4,
    pickThenMode: 'fingerpick',
  },
  'folk-fingerstyle': {
    label: 'Folk Fingerstyle',
    mode: 'arpeggio-slow',
    swing: 7,
    velocity: 78,
    humanizeTimeMs: 10,
    humanizeVelPct: 8,
    tightness: 0.85,
    instruments: ['steel'],
    pickPattern: '5 4 3 1 6 4 3 1',
    pickBeats: 4,
    pickThenMode: 'arpeggio-slow',
  },
  'picking-into-strum': {
    label: 'Pick -> Strum',
    mode: 'pattern-8',
    swing: 6,
    velocity: 82,
    pickPattern: '5431 6541',
    pickBeats: 2,
    pickThenMode: 'pattern-8',
  },
  'waltz-folk': {
    label: 'Waltz Folk 3/4 feel',
    mode: 'pattern-6',
    swing: 9,
    velocity: 78,
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'pattern-6',
  },
  'blues-shuffle': {
    label: 'Blues Shuffle',
    mode: 'pattern-6',
    swing: 22,
    velocity: 84,
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'pattern-6',
  },
  'latin-bossa': {
    label: 'Latin Bossa',
    mode: 'pattern-12-mute',
    swing: 12,
    velocity: 74,
    pickPattern: '6 3 4 2',
    pickBeats: 1,
    pickThenMode: 'pattern-12-mute',
  },
  'cinematic-arp': {
    label: 'Cinematic Arpeggio',
    mode: 'arpeggio-wide',
    swing: 4,
    velocity: 72,
    pickPattern: '',
    pickBeats: 0,
    pickThenMode: 'arpeggio-wide',
  },
};
const PLAY_STYLE_IDS = Object.keys(PLAY_STYLE_PRESETS);

function expandChordBlocks(blocks) {
  const out = [];
  if (!Array.isArray(blocks)) return out;

  blocks.forEach(block => {
    if (Array.isArray(block)) {
      out.push(...block);
      return;
    }

    if (!block || typeof block !== 'object' || !Array.isArray(block.seq)) return;
    const times = Math.max(1, Math.min(64, parseInt(block.times, 10) || 1));
    for (let i = 0; i < times; i++) out.push(...block.seq);
  });

  return out;
}

const THE_UNFORGIVEN_PROGRESSION = expandChordBlocks([
  // Intro
  ['Am'],
  ['Am', 'C', 'G', 'Em'],
  ['Am', 'C', 'G', 'E'],
  ['Am'],

  // Verse 1
  { times: 4, seq: ['Am', 'Em', 'D', 'Am'] },
  ['C', 'G', 'Am'],
  ['C', 'G', 'E'],

  // Chorus 1
  ['Am', 'C', 'G', 'Em', 'Am'],
  ['C', 'G', 'E', 'Am'],
  ['Am', 'C', 'G', 'Em', 'Am'],
  ['C', 'G', 'E', 'Am'],

  // Verse 2
  { times: 4, seq: ['Am', 'Em', 'D', 'Am'] },
  ['C', 'G', 'Am'],
  ['C', 'G', 'E'],

  // Chorus 2
  ['Am', 'C', 'G', 'Em', 'Am'],
  ['C', 'G', 'E', 'Am'],
  ['Am', 'C', 'G', 'Em', 'Am'],
  ['C', 'G', 'E', 'Am'],

  // Solo
  ['Am'],
  { times: 3, seq: ['Am', 'Em', 'D', 'Am'] },
  ['Am', 'Em', 'D'],
  ['Am', 'C', 'G'],
  ['Am', 'C', 'G', 'E'],

  // Chorus 3
  ['Am', 'C', 'G', 'Em', 'Am'],
  ['C', 'G', 'E', 'Am'],
  ['Am', 'C', 'G', 'Em', 'Am'],
  ['C', 'G', 'E', 'Am', 'C', 'G', 'Em'],

  // Interlude
  ['Am', 'C', 'G', 'Em'],

  // Outro
  { times: 4, seq: ['Am', 'C', 'G', 'E', 'Am', 'C', 'G', 'E'] },
  ['Am', 'C', 'G', 'E', 'Am'],
]);

const IN_THE_ARMY_NOW_PROGRESSION = expandChordBlocks([
  // Intro (arpeggio Bm)
  ['Bm', 'Bm', 'Bm', 'Bm'],

  // Verse 1
  { times: 3, seq: ['Bm', 'Bm', 'D', 'A'] },
  ['Bm', 'Bm', 'G', 'A'],

  // Chorus 1
  { times: 2, seq: ['G', 'D', 'A', 'Bm'] },

  // Verse 2
  { times: 3, seq: ['Bm', 'Bm', 'D', 'A'] },
  ['Bm', 'Bm', 'G', 'A'],

  // Chorus 2
  { times: 2, seq: ['G', 'D', 'A', 'Bm'] },

  // Bridge
  ['Em', 'Em', 'G', 'G'],
  ['D', 'D', 'A', 'A'],

  // Chorus 3
  { times: 2, seq: ['G', 'D', 'A', 'Bm'] },

  // Outro
  ['Bm', 'Bm', 'D', 'A'],
  ['Bm', 'Bm', 'Bm', 'Bm'],
]);

// ===================== STATE =====================
let steps = [];
let numSteps = 8;
let currentStep = 0;
let isPlaying = false;
let isStarting = false;
let tempo = 90;
let volume = 0.8;
let velocity = 0.8;
let swingAmount = 0;
let strumMode = 'strum-down';
let playStyle = 'custom';
let pickPatternText = '';
let pickBeats = 0;
let pickThenMode = 'strum-down';
let singleString = null;
let playInterval = null;
let hitTimers = [];
let transportState = 'stopped';
let statusFlashTimer = null;

// Global humanization / timing / mixing controls
let humanizeTimeMs = 10; // 0..20
let humanizeVelPct = 8; // 0..20 percent
let tightness = 0.85; // 0..1 (1 = very tight)

// Per-instrument mix (level/pan/mute/octave/fx)
let instrumentMix = {}; // filled per active instrument

// Optional song structure
let sections = [];
let loopRegion = null;
let arrangementNotes = '';

// Capo / tuning
let capo = 0;
let tuning = ['E2','A2','D3','G3','B3','E4'];

function getStatusText(state = transportState) {
  if (state === 'playing') return 'Відтворення...';
  if (state === 'paused') return 'Пауза';
  return 'Зупинено';
}

function setTransportState(state) {
  transportState = state;
  const statusBar = document.querySelector('.status-bar');
  if (statusBar) statusBar.classList.toggle('playing', state === 'playing');
  document.getElementById('statusText').textContent = getStatusText(state);
}

function flashStatus(text, ms = 1400) {
  const statusEl = document.getElementById('statusText');
  clearTimeout(statusFlashTimer);
  statusEl.textContent = text;
  statusFlashTimer = setTimeout(() => {
    statusEl.textContent = getStatusText();
  }, ms);
}

function syncChordCountButtons() {
  document.querySelectorAll('#countBtns .count-btn').forEach(btn => {
    const n = parseInt(btn.dataset.n, 10);
    btn.classList.toggle('active', n === numSteps);
  });
}

function clamp(num, min, max) {
  return Math.min(max, Math.max(min, num));
}

function getEffectiveTightness(stepMeta = null) {
  const raw = Number.isFinite(stepMeta?.tightness) ? stepMeta.tightness : tightness;
  return clamp(raw, 0, 1);
}

function getEffectiveHumanizeTimeMs(stepMeta = null) {
  const raw = Number.isFinite(stepMeta?.humanizeTimeMs) ? stepMeta.humanizeTimeMs : humanizeTimeMs;
  let base = clamp(raw, 0, 20);
  // Musical humanize: at high BPM (>150), compress timing humanize to avoid sloppy feel
  if (tempo > 150) {
    const compress = clamp(1 - (tempo - 150) / 100, 0.2, 1);
    base *= compress;
  }
  return base;
}

function getEffectiveHumanizeVel(stepMeta = null) {
  const fallback = Number.isFinite(humanizeVelPct) ? humanizeVelPct / 100 : 0.08;
  const raw = Number.isFinite(stepMeta?.humanizeVel) ? stepMeta.humanizeVel : fallback;
  return clamp(raw, 0, 0.35);
}

function getVelocityHumanizeMultiplier(stepMeta = null, depth = 1) {
  const amount = getEffectiveHumanizeVel(stepMeta) * clamp(depth, 0, 1.5);
  return 1 + ((Math.random() * 2 - 1) * amount);
}

function getTimingHumanizeMs(stepMeta = null, capMs = null) {
  const humanMs = getEffectiveHumanizeTimeMs(stepMeta);
  const looseness = 1 - getEffectiveTightness(stepMeta);
  const rawCap = Number.isFinite(capMs) ? capMs : (humanMs * (0.5 + looseness * 0.8));
  const maxJitter = Math.max(0, rawCap);
  if (maxJitter <= 0.01) return 0;
  return (Math.random() * 2 - 1) * maxJitter;
}

function getStrumSpreadSeconds(mode = 'strum-down', direction = 'down', stepMeta = null) {
  const humanMs = getEffectiveHumanizeTimeMs(stepMeta);
  const looseness = 1 - getEffectiveTightness(stepMeta);
  const modeBaseMs = mode === 'slow-strum'
    ? 20
    : (mode && mode.startsWith('pattern-') ? 11 : 14);
  const directionBiasMs = direction === 'up' ? -1.2 : 1.8;
  // Tempo-dependent spread: at high BPM, tighter strumming to avoid "smearing"
  const tempoScale = clamp(1.15 - (tempo - 80) / 240, 0.4, 1.2);
  const spreadMs = clamp(
    (modeBaseMs + directionBiasMs + (humanMs * 0.35) + (looseness * 9) + (Math.random() * 4.5)) * tempoScale,
    4,
    30
  );
  return spreadMs / 1000;
}

function getModeReleaseMultiplier(mode = strumMode) {
  if (mode === 'mute') return 0.72;
  if (mode === 'slow-strum') return 1.28;
  if (mode === 'arpeggio' || mode === 'arpeggio-slow' || mode === 'arpeggio-wide' || mode === 'arpeggio-rev' || mode === 'fingerpick') return 1.18;
  if (mode && mode.startsWith('pattern-')) return 0.92;
  return 1;
}

function setSongBarsSelectValue(value) {
  const select = document.getElementById('songBarsInput');
  if (!select) return;

  const safe = clamp(parseInt(value, 10) || 16, MIN_STEPS, MAX_STEPS);
  const hasOption = Array.from(select.options).some(opt => parseInt(opt.value, 10) === safe);
  if (!hasOption) {
    const option = document.createElement('option');
    option.value = String(safe);
    option.textContent = `${safe} bars`;
    option.dataset.dynamic = '1';
    select.appendChild(option);
  }
  select.value = String(safe);
}

function bpmToMs(bpm) {
  return 60000 / clamp(Math.round(bpm), 40, 200);
}

function getBeatsPerBar() {
  return 4;
}

function clearHitTimers() {
  hitTimers.forEach(timerId => clearTimeout(timerId));
  hitTimers = [];
}

// Returns a per-bar pulse map for each strum mode.
function getStrumPattern(mode) {
  switch (mode) {
    // ================================
    // AUTHENTIC GUITAR STRUMMING PATTERNS (БОЇ)
    // ================================

    // Четвірка: ↓ ↑ ✕ ↑ — класичний бій з глушенням на 3-й долі
    case 'pattern-4':
      return ['down', 'up', 'mute', 'up'];

    // Четвірка з глушенням: ↓ ✕ ↑ ✕ — акцент на 1 і 3, перкусивний
    case 'pattern-4-mute':
      return ['down', 'mute', 'up', 'mute'];

    // Шістка: ↓ ↓ ↑ ↑ ↓ ↑ — легендарний український бій
    // Ритм: 1 (↓ сильна) 2 (↓ слабка) 3 (↑ слабка) 4 (↑ АКЦЕНТ!) 5 (↓ середня) 6 (↑ слабка)
    case 'pattern-6':
      return ['down', 'down', 'up', 'up', 'down', 'up'];

    // Шістка з глушенням: ↓ ✕ ↑ ✕ ↓ ✕
    case 'pattern-6-mute':
      return ['down', 'mute', 'up', 'mute', 'down', 'mute'];

    // Вісімка: ↓ ↓ ↑ ↑ ↓ ↑ ↓ ↑ — розширена шістка, 8 ударів на такт
    case 'pattern-8':
      return ['down', 'down', 'up', 'up', 'down', 'up', 'down', 'up'];

    // Вісімка з глушенням: ↓ ✕ ↑ ✕ ↓ ✕ ↓ ✕
    case 'pattern-8-mute':
      return ['down', 'mute', 'up', 'mute', 'down', 'mute', 'down', 'mute'];

    // Дванадцятка (тріольний філ 12/8): групи по 3 — ↓↓↑ ↑↓↑ ↓↓↑ ↑↓↑
    case 'pattern-12':
      return ['down','down','up', 'up','down','up', 'down','down','up', 'up','down','up'];

    // Дванадцятка з глушенням: ↓✕↑ ✕↓✕ ↓✕↑ ✕↓✕
    case 'pattern-12-mute':
      return ['down','mute','up', 'mute','down','mute', 'down','mute','up', 'mute','down','mute'];

    // Електро бас / palm mute: ↓ ✕ ↑ ↓ ↑ ✕ ↓ ↑
    case 'pattern-electric-bass':
      return ['down', 'mute', 'up', 'down', 'up', 'mute', 'down', 'up'];

    case 'strum-down':
      return ['down'];
    case 'strum-up':
      return ['up'];
    case 'strum-both':
      return ['both'];
    case 'arpeggio':
    case 'fingerpick':
    case 'arpeggio-slow':
    case 'arpeggio-wide':
      return ['arp'];
    case 'arpeggio-rev':
      return ['arpRev'];
    case 'mute':
      return ['mute'];
    case 'slow-strum':
      return ['slow'];
    default:
      return ['down'];
  }
}

function getPatternHitVelocityMultiplier(mode, hitIndex) {
  // ===================== AUTHENTIC ACCENT PROFILES =====================
  // Кожен бій має свій характерний акцентний рисунок.
  // Числа — множник гучності кожного удару. 1.0 = повна сила.
  const ACCENT_PROFILES = {
    // Четвірка: сильний 1-й, легкий апстрок, глушений, легкий апстрок
    'pattern-4':      [1.0,  0.62, 0.38, 0.58],
    'pattern-4-mute': [0.88, 0.35, 0.72, 0.32],

    // Шістка — акцент на 1-й та 4-й (характерна «підкидка» на 4-й ↑)
    'pattern-6':      [1.0,  0.52, 0.48, 0.94, 0.72, 0.48],
    'pattern-6-mute': [0.92, 0.32, 0.62, 0.30, 0.82, 0.32],

    // Вісімка — акценти на 1, 4, 5
    'pattern-8':      [1.0,  0.48, 0.44, 0.92, 0.72, 0.44, 0.68, 0.46],
    'pattern-8-mute': [0.92, 0.30, 0.55, 0.28, 0.82, 0.30, 0.65, 0.28],

    // Дванадцятка — тріольні акценти (перший кожної трійки сильніший)
    'pattern-12':      [1.0, 0.48, 0.42, 0.90, 0.48, 0.42, 0.80, 0.48, 0.42, 0.90, 0.48, 0.42],
    'pattern-12-mute': [0.88, 0.28, 0.50, 0.28, 0.78, 0.28, 0.72, 0.28, 0.50, 0.28, 0.78, 0.28],

    // Електро бас / power chord — важкі даунстроки
    'pattern-electric-bass': [1.0, 0.34, 0.55, 0.90, 0.58, 0.32, 0.92, 0.55],
  };
  const profile = ACCENT_PROFILES[mode];
  if (profile) return profile[hitIndex % profile.length];
  return 1.0;
}

// Per-hit string coverage ratio — в справжньому бої не кожен удар чіпає всі 6 струн.
// Даунстроки — більше струн, апстроки — менше (2-4 верхні), глушення — середнє.
function getPatternHitRatio(mode, hitIndex) {
  const RATIO_PROFILES = {
    // Четвірка
    'pattern-4':      [1.0,  0.55, 0.72, 0.52],
    'pattern-4-mute': [0.85, 0.72, 0.65, 0.72],

    // Шістка — 2-й даунстрок лише верхні 4, апстроки — нижні 3-4
    'pattern-6':      [1.0,  0.62, 0.50, 0.78, 0.82, 0.48],
    'pattern-6-mute': [0.88, 0.72, 0.58, 0.72, 0.85, 0.72],

    // Вісімка
    'pattern-8':      [1.0,  0.58, 0.48, 0.75, 0.82, 0.46, 0.70, 0.48],
    'pattern-8-mute': [0.88, 0.72, 0.52, 0.72, 0.85, 0.72, 0.70, 0.72],

    // Дванадцятка
    'pattern-12':      [1.0, 0.55, 0.46, 0.78, 0.55, 0.46, 0.82, 0.55, 0.46, 0.78, 0.55, 0.46],
    'pattern-12-mute': [0.88, 0.72, 0.50, 0.72, 0.80, 0.72, 0.75, 0.72, 0.50, 0.72, 0.80, 0.72],

    // Електро бас
    'pattern-electric-bass': [1.0, 0.72, 0.52, 0.88, 0.55, 0.72, 0.92, 0.55],
  };
  const profile = RATIO_PROFILES[mode];
  if (profile) return profile[hitIndex % profile.length];
  return 1.0;
}

function overrideToHit(strumOverride) {
  if (strumOverride === 0) return 'down';
  if (strumOverride === 1) return 'up';
  if (strumOverride === 2) return 'arp';
  if (strumOverride === 3) return 'mute';
  return null;
}

function hitToMode(hit) {
  if (hit === 'up') return 'strum-up';
  if (hit === 'both') return 'strum-both';
  if (hit === 'slow') return 'slow-strum';
  if (hit === 'arp') return 'arpeggio';
  if (hit === 'arpRev') return 'arpeggio-rev';
  if (hit === 'mute') return 'mute';
  return 'strum-down';
}

function parseSingleStringLoose(value) {
  if (value === null || value === undefined || value === '' || value === 'all') return null;
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  if (!Number.isInteger(n) || n < 1 || n > 6) return null;
  return n;
}

function normalizeMode(mode, fallback = 'strum-down') {
  if (typeof mode !== 'string') return fallback;
  const raw = mode.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  const aliases = {
    'down': 'strum-down',
    'up': 'strum-up',
    'both': 'strum-both',
    'arp': 'arpeggio',
    'arpeggio-reverse': 'arpeggio-rev',
    'slow': 'slow-strum',
    '4': 'pattern-4',
    '4-mute': 'pattern-4-mute',
    'pattern4': 'pattern-4',
    'pattern4-mute': 'pattern-4-mute',
    '6': 'pattern-6',
    '6-mute': 'pattern-6-mute',
    'pattern6': 'pattern-6',
    'pattern6-mute': 'pattern-6-mute',
    '8': 'pattern-8',
    '8-mute': 'pattern-8-mute',
    'pattern8': 'pattern-8',
    'pattern8-mute': 'pattern-8-mute',
    'electric-bass': 'pattern-electric-bass',
    'electro-bass': 'pattern-electric-bass',
    'pattern-electric': 'pattern-electric-bass',
  };
  const resolved = aliases[raw] || raw;
  return AVAILABLE_MODES.includes(resolved) ? resolved : fallback;
}

function normalizePlayStyle(style, fallback = 'custom') {
  if (typeof style !== 'string') return fallback;
  const raw = style.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  const aliases = {
    'preset': 'custom',
    'style': 'custom',
    'rock': 'rock-open',
    'pop': 'acoustic-pop-8',
    'funk': 'funk-mute',
    'reggae': 'reggae-skank',
    'country': 'country-travis',
    'folk': 'folk-fingerstyle',
    'blues': 'blues-shuffle',
    'bossa': 'latin-bossa',
    'latin': 'latin-bossa',
    'metal': 'metal-chug',
    'hardrock': 'hard-rock',
    'hard-rock': 'hard-rock',
    'travis': 'country-travis',
    'fingerstyle': 'folk-fingerstyle',
    'pick-strum': 'picking-into-strum',
  };
  const resolved = aliases[raw] || raw;
  return PLAY_STYLE_PRESETS[resolved] ? resolved : fallback;
}

function parsePickPatternTokens(value) {
  const out = [];
  const pushToken = token => {
    if (token === null || token === undefined) return;
    if (typeof token === 'number' && Number.isInteger(token) && token >= 1 && token <= 6) {
      out.push(token);
      return;
    }
    const str = String(token).trim().toLowerCase();
    if (!str) return;
    if (str === 'x' || str === 'm' || str === 'mute' || str === '-') {
      out.push('mute');
      return;
    }
    if (/^[1-6]$/.test(str)) {
      out.push(parseInt(str, 10));
    }
  };

  if (Array.isArray(value)) {
    value.forEach(pushToken);
    return out;
  }

  if (typeof value !== 'string') return out;
  const cleaned = value.trim();
  if (!cleaned) return out;

  const groups = cleaned
    .replace(/[|,;]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  groups.forEach(group => {
    const compact = group.toLowerCase();
    if (/^[1-6xXmM-]+$/.test(compact)) {
      for (const chr of compact) pushToken(chr);
      return;
    }
    pushToken(compact);
  });

  return out.slice(0, 64);
}

function formatPickPatternText(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return '';
  const chars = tokens.map(token => token === 'mute' ? 'x' : String(token));
  const grouped = [];
  for (let i = 0; i < chars.length; i += 4) grouped.push(chars.slice(i, i + 4).join(''));
  return grouped.join(' ');
}

function normalizePickPatternText(value) {
  return formatPickPatternText(parsePickPatternTokens(value));
}

function parsePickBeatsLoose(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n * 4) / 4;
  return clamp(rounded, 0, 4);
}

function updatePlayStyleUI() {
  const select = document.getElementById('playStyleSelect');
  if (!select) return;
  playStyle = normalizePlayStyle(playStyle, 'custom');
  select.value = playStyle;
}

function updatePickPatternUI() {
  const input = document.getElementById('pickPatternInput');
  if (!input) return;
  pickPatternText = normalizePickPatternText(pickPatternText);
  input.value = pickPatternText;
}

function updatePickBeatsUI() {
  const input = document.getElementById('pickBeatsInput');
  if (!input) return;
  pickBeats = parsePickBeatsLoose(pickBeats, 0);
  input.value = String(pickBeats);
}

function updatePickThenModeUI() {
  const select = document.getElementById('pickThenModeSelect');
  if (!select) return;
  pickThenMode = normalizeMode(pickThenMode, 'strum-down');
  select.value = pickThenMode;
}

function updatePickingUI() {
  updatePickPatternUI();
  updatePickBeatsUI();
  updatePickThenModeUI();
}

function populateStyleControls() {
  const styleSelect = document.getElementById('playStyleSelect');
  if (styleSelect && !styleSelect.options.length) {
    PLAY_STYLE_IDS.forEach(styleId => {
      const option = document.createElement('option');
      option.value = styleId;
      option.textContent = PLAY_STYLE_PRESETS[styleId].label;
      styleSelect.appendChild(option);
    });
  }

  const modeSelect = document.getElementById('pickThenModeSelect');
  if (modeSelect && !modeSelect.options.length) {
    AVAILABLE_MODES.forEach(mode => {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = mode;
      modeSelect.appendChild(option);
    });
  }
}

function applyStylePreset(styleId, options = {}) {
  const { quiet = false } = options;
  const safeStyle = normalizePlayStyle(styleId, 'custom');
  const preset = PLAY_STYLE_PRESETS[safeStyle] || PLAY_STYLE_PRESETS.custom;
  playStyle = safeStyle;

  if (preset.mode) setStrumMode(preset.mode);
  if (Number.isFinite(preset.tempo)) tempo = clamp(Math.round(preset.tempo), 40, 200);
  if (Number.isFinite(preset.swing)) swingAmount = clamp(Math.round(preset.swing), 0, 70);
  if (Number.isFinite(preset.velocity)) velocity = clamp(Math.round(preset.velocity), 10, 100) / 100;
  if (Number.isFinite(preset.humanizeTimeMs)) humanizeTimeMs = clamp(+preset.humanizeTimeMs, 0, 20);
  if (Number.isFinite(preset.humanizeVelPct)) humanizeVelPct = clamp(+preset.humanizeVelPct, 0, 20);
  if (Number.isFinite(preset.tightness)) tightness = clamp(+preset.tightness, 0, 1);
  if (preset.instruments !== undefined) setActiveInstruments(preset.instruments, { quiet: true });
  if (typeof preset.pickPattern === 'string') pickPatternText = normalizePickPatternText(preset.pickPattern);
  if (preset.pickBeats !== undefined) pickBeats = parsePickBeatsLoose(preset.pickBeats, pickBeats);
  if (preset.pickThenMode) pickThenMode = normalizeMode(preset.pickThenMode, pickThenMode);

  updatePlayStyleUI();
  updateTempoUI();
  updateSwingUI();
  updateVelocityUI();
  updatePickingUI();

  if (!quiet) flashStatus(`Style: ${preset.label}`, 1500);
}

function setCustomPlayStyle() {
  playStyle = 'custom';
  updatePlayStyleUI();
}

function updateTempoUI() {
  const slider = document.getElementById('tempoSlider');
  if (!slider) return;
  slider.value = tempo;
  document.getElementById('bpmDisplay').textContent = tempo;
  const pct = ((tempo - 40) / (200 - 40)) * 100;
  slider.style.setProperty('--v', `${pct}%`);
}

function updateVolumeUI() {
  const slider = document.getElementById('volSlider');
  if (!slider) return;
  const percent = Math.round(volume * 100);
  slider.value = percent;
  document.getElementById('volDisplay').textContent = percent;
  slider.style.setProperty('--v', `${percent}%`);
}

function updateVelocityUI() {
  const slider = document.getElementById('velSlider');
  if (!slider) return;
  const percent = Math.round(velocity * 100);
  slider.value = percent;
  document.getElementById('velDisplay').textContent = percent;
  slider.style.setProperty('--v', `${percent}%`);
}

function updateSwingUI() {
  const slider = document.getElementById('swingSlider');
  if (!slider) return;
  slider.value = swingAmount;
  document.getElementById('swingDisplay').textContent = swingAmount;
  const pct = (swingAmount / 70) * 100;
  slider.style.setProperty('--v', `${pct}%`);
}

function updateSingleStringUI() {
  const select = document.getElementById('singleStringSelect');
  if (!select) return;
  const normalized = parseSingleStringLoose(singleString);
  singleString = normalized;
  select.value = normalized === null ? 'all' : String(normalized);
}

function setStrumMode(mode) {
  const safeMode = normalizeMode(mode);
  strumMode = safeMode;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === safeMode);
  });
}

// Init steps
function initSteps(n) {
  const prev = steps.slice();
  steps = [];
  const defaults = ['Am','C','G','Em','F','Dm','G','Em'];
  for (let i = 0; i < n; i++) {
    steps.push({
      chord: prev[i] ? prev[i].chord : (defaults[i] || 'Am'),
      strumOverride: prev[i] ? prev[i].strumOverride : null,
      modeOverride: prev[i] ? prev[i].modeOverride : null,
      singleStringOverride: prev[i] ? parseSingleStringLoose(prev[i].singleStringOverride) : null,
      pickPattern: prev[i] ? normalizePickPatternText(prev[i].pickPattern || '') || null : null,
      pickBeats: prev[i] ? parsePickBeatsLoose(prev[i].pickBeats, null) : null,
      pickThenMode: prev[i] ? normalizeMode(prev[i].pickThenMode, null) : null,
      vel: prev[i] && Number.isFinite(prev[i].vel) ? clamp(Math.round(prev[i].vel), 0, 100) : null,
      accent: prev[i] && Number.isFinite(prev[i].accent) ? +prev[i].accent : null,
      humanizeVel: prev[i] && Number.isFinite(prev[i].humanizeVel) ? +prev[i].humanizeVel : null,
      pushMs: prev[i] && Number.isFinite(prev[i].pushMs) ? +prev[i].pushMs : null,
      swingOverride: prev[i] && Number.isFinite(prev[i].swingOverride) ? clamp(Math.round(prev[i].swingOverride), 0, 70) : null,
      hits: prev[i] && Array.isArray(prev[i].hits)
        ? prev[i].hits.map(h => ({ type: h.type, vel: h.vel, swing: h.swing, spread: h.spread, take: h.take }))
        : null,
      riff: prev[i] && prev[i].riff && typeof prev[i].riff === 'object'
        ? {
            string: parseSingleStringLoose(prev[i].riff.string) ?? 2,
            frets: Array.isArray(prev[i].riff.frets) ? prev[i].riff.frets.map(f => Math.max(0, Math.round(f))) : [],
            slide: Boolean(prev[i].riff.slide),
            hammer: Boolean(prev[i].riff.hammer),
            riffVel: Number.isFinite(prev[i].riff.riffVel) ? clamp(Math.round(prev[i].riff.riffVel), 0, 100) : null,
            riffHumanize: Number.isFinite(prev[i].riff.riffHumanize) ? +prev[i].riff.riffHumanize : null,
          }
        : null,
      riffBeats: prev[i] && Number.isFinite(prev[i].riffBeats) ? clamp(Math.round(prev[i].riffBeats), 1, 4) : null,
    });
  }
  renderSteps();
}

function applyPattern(pattern) {
  if (!Array.isArray(pattern) || pattern.length === 0) return;
  steps.forEach((step, i) => {
    step.chord = pattern[i % pattern.length];
    step.strumOverride = null;
    step.modeOverride = null;
    step.singleStringOverride = null;
    step.pickPattern = null;
    step.pickBeats = null;
    step.pickThenMode = null;
    step.vel = null;
    step.accent = null;
    step.humanizeVel = null;
    step.pushMs = null;
    step.swingOverride = null;
    step.hits = null;
    step.riff = null;
    step.riffBeats = null;
  });
  renderSteps();
  const chord = steps[currentStep] ? steps[currentStep].chord : '—';
  updateChordDisplay(chord);
}

function randomizePattern() {
  const generated = [];
  for (let i = 0; i < steps.length; i++) {
    let chord = PLAYABLE_CHORDS[Math.floor(Math.random() * PLAYABLE_CHORDS.length)];
    if (generated.length > 0 && chord === generated[generated.length - 1]) {
      const alt = PLAYABLE_CHORDS.filter(c => c !== chord);
      chord = alt[Math.floor(Math.random() * alt.length)];
    }
    generated.push(chord);
  }
  applyPattern(generated);
  flashStatus('Згенеровано новий патерн');
}

function clearPattern() {
  steps.forEach(step => {
    step.chord = '—';
    step.strumOverride = null;
    step.modeOverride = null;
    step.singleStringOverride = null;
    step.pickPattern = null;
    step.pickBeats = null;
    step.pickThenMode = null;
    step.vel = null;
    step.accent = null;
    step.humanizeVel = null;
    step.pushMs = null;
    step.swingOverride = null;
    step.hits = null;
    step.riff = null;
    step.riffBeats = null;
  });
  renderSteps();
  updateChordDisplay('—');
  flashStatus('Патерн очищено');
}

function applyTheUnforgivenPreset() {
  const progression = compressProgression(
    THE_UNFORGIVEN_PROGRESSION.map(chord => normalizeChordName(chord, 'Am')),
    MAX_STEPS
  );
  if (progression.length < MIN_STEPS) {
    flashStatus('Не вдалося завантажити пресет', 1900);
    return;
  }

  if (isPlaying) stopSequencer();

  numSteps = clamp(progression.length, MIN_STEPS, MAX_STEPS);
  setSongBarsSelectValue(numSteps);
  syncChordCountButtons();
  initSteps(numSteps);
  applyPattern(progression);

  tempo = 70;
  updateTempoUI();
  swingAmount = 6;
  updateSwingUI();
  velocity = 0.82;
  updateVelocityUI();
  setStrumMode('pattern-8');
  playStyle = 'rock-open';
  pickPatternText = '';
  pickBeats = 0;
  pickThenMode = 'pattern-8';
  updatePlayStyleUI();
  updatePickingUI();
  singleString = null;
  updateSingleStringUI();

  const songNameEl = document.getElementById('songNameInput');
  if (songNameEl) songNameEl.value = 'The Unforgiven';
  const styleEl = document.getElementById('songStyleInput');
  if (styleEl) styleEl.value = 'Heavy acoustic rock ballad';
  const moodEl = document.getElementById('songMoodInput');
  if (moodEl) moodEl.value = 'Dark, dramatic';
  const keyEl = document.getElementById('songKeyInput');
  if (keyEl) keyEl.value = 'Am';
  const bpmHintEl = document.getElementById('songBpmHintInput');
  if (bpmHintEl) bpmHintEl.value = '70';

  const tabEl = document.getElementById('tabInput');
  if (tabEl) tabEl.value = progression.join(' ');

  flashStatus(`The Unforgiven: ${numSteps} bars @ 70 BPM`, 2600);
}

function applyInTheArmyNowPreset() {
  const progression = compressProgression(
    IN_THE_ARMY_NOW_PROGRESSION.map(chord => normalizeChordName(chord, 'Bm')),
    MAX_STEPS
  );
  if (progression.length < MIN_STEPS) {
    flashStatus('Не вдалося завантажити пресет', 1900);
    return;
  }

  if (isPlaying) stopSequencer();

  numSteps = clamp(progression.length, MIN_STEPS, MAX_STEPS);
  setSongBarsSelectValue(numSteps);
  syncChordCountButtons();
  initSteps(numSteps);
  applyPattern(progression);

  tempo = 104;
  updateTempoUI();
  swingAmount = 5;
  updateSwingUI();
  velocity = 0.78;
  updateVelocityUI();
  setStrumMode('pattern-8');
  playStyle = 'pop-ballad';
  pickPatternText = '';
  pickBeats = 0;
  pickThenMode = 'pattern-8';
  updatePlayStyleUI();
  updatePickingUI();
  singleString = null;
  updateSingleStringUI();

  const songNameEl = document.getElementById('songNameInput');
  if (songNameEl) songNameEl.value = 'In The Army Now';
  const styleEl = document.getElementById('songStyleInput');
  if (styleEl) styleEl.value = 'Pop rock ballad';
  const moodEl = document.getElementById('songMoodInput');
  if (moodEl) moodEl.value = 'Melancholic, anthemic';
  const keyEl = document.getElementById('songKeyInput');
  if (keyEl) keyEl.value = 'Bm';
  const bpmHintEl = document.getElementById('songBpmHintInput');
  if (bpmHintEl) bpmHintEl.value = '104';

  const tabEl = document.getElementById('tabInput');
  if (tabEl) tabEl.value = progression.join(' ');

  setActiveInstruments(['steel'], { quiet: true });

  flashStatus(`In The Army Now: ${numSteps} bars @ 104 BPM`, 2600);
}

function applyNonStopCleanup(options = {}) {
  const { quiet = false } = options;
  if (!Array.isArray(steps) || steps.length === 0) return;

  const blockedModes = new Set(['slow-strum', 'arpeggio', 'arpeggio-rev', 'arpeggio-slow', 'arpeggio-wide', 'fingerpick']);
  const pickResetTempoThreshold = 150;
  let modeFixes = 0;
  let swingFixes = 0;
  let pickFixes = 0;

  applyStylePreset('non-stop-punk', { quiet: true });
  setActiveInstruments(['electric', 'bass'], { quiet: true });

  if (swingAmount > 3) {
    swingAmount = 0;
    swingFixes++;
  }

  if (tempo < 150) {
    tempo = 155;
  }

  setStrumMode(blockedModes.has(strumMode) ? 'pattern-8-mute' : normalizeMode(strumMode, 'pattern-8-mute'));

  steps.forEach((step, i) => {
    if (!step || typeof step !== 'object') return;

    if (!PLAYABLE_CHORDS.includes(step.chord)) {
      step.modeOverride = null;
      step.pickPattern = null;
      step.pickBeats = null;
      step.pickThenMode = null;
      return;
    }

    if (Number.isFinite(step.swingOverride) && step.swingOverride > 3) {
      step.swingOverride = 0;
      swingFixes++;
    }

    const stepMode = step.modeOverride ? normalizeMode(step.modeOverride, null) : null;
    if (stepMode && blockedModes.has(stepMode)) {
      const isStrong = Number.isFinite(step.vel) ? step.vel >= 90 : (i % 4 === 0);
      step.modeOverride = isStrong ? 'pattern-8' : 'pattern-8-mute';
      modeFixes++;
    }

    if (tempo >= pickResetTempoThreshold && (step.pickPattern || Number.isFinite(step.pickBeats) || step.pickThenMode)) {
      step.pickPattern = null;
      step.pickBeats = null;
      step.pickThenMode = null;
      pickFixes++;
    }
  });

  updateTempoUI();
  updateSwingUI();
  updateVelocityUI();
  updatePlayStyleUI();
  updatePickingUI();
  renderSteps();
  updateChordDisplay(steps[currentStep] ? steps[currentStep].chord : '—');

  if (!quiet) {
    flashStatus(`Non-Stop fix: mode ${modeFixes}, swing ${swingFixes}, pick ${pickFixes}`, 2600);
  }
}

function savePattern() {
  try {
    const payload = {
      numSteps,
      mode: strumMode,
      tempo,
      swing: swingAmount,
      velocity: Math.round(velocity * 100),
      volume: Math.round(volume * 100),
      singleString,
      guitarType,
      playStyle,
      pickPattern: pickPatternText,
      pickBeats,
      pickThenMode,
      instruments: [...getActiveInstrumentList()],
      steps: steps.map(step => ({
        chord: step.chord,
        strumOverride: step.strumOverride,
        modeOverride: step.modeOverride,
        singleStringOverride: parseSingleStringLoose(step.singleStringOverride),
        pickPattern: step.pickPattern || null,
        pickBeats: parsePickBeatsLoose(step.pickBeats, null),
        pickThenMode: step.pickThenMode || null,
        vel: Number.isFinite(step.vel) ? clamp(Math.round(step.vel), 0, 100) : null,
        accent: Number.isFinite(step.accent) ? +step.accent : null,
        humanizeVel: Number.isFinite(step.humanizeVel) ? +step.humanizeVel : null,
        pushMs: Number.isFinite(step.pushMs) ? +step.pushMs : null,
        swingOverride: Number.isFinite(step.swingOverride) ? clamp(Math.round(step.swingOverride), 0, 70) : null,
        hits: Array.isArray(step.hits) ? step.hits.map(h => ({ type: h.type, vel: h.vel, swing: h.swing, spread: h.spread, take: h.take })) : null,
        riff: step.riff && typeof step.riff === 'object'
          ? {
              string: parseSingleStringLoose(step.riff.string) ?? 2,
              frets: Array.isArray(step.riff.frets) ? step.riff.frets.map(f => Math.max(0, Math.round(f))) : [],
              slide: Boolean(step.riff.slide),
              hammer: Boolean(step.riff.hammer),
              riffVel: Number.isFinite(step.riff.riffVel) ? clamp(Math.round(step.riff.riffVel), 0, 100) : null,
              riffHumanize: Number.isFinite(step.riff.riffHumanize) ? +step.riff.riffHumanize : null,
            }
          : null,
        riffBeats: Number.isFinite(step.riffBeats) ? clamp(Math.round(step.riffBeats), 1, 4) : null,
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    flashStatus('Патерн збережено');
  } catch (err) {
    flashStatus('Не вдалося зберегти');
  }
}

function loadPattern() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.steps)) return false;

    const nextNumSteps = clamp(parseInt(saved.numSteps, 10) || saved.steps.length || 8, MIN_STEPS, MAX_STEPS);
    numSteps = nextNumSteps;
    setSongBarsSelectValue(nextNumSteps);
    tempo = clamp(parseInt(saved.tempo, 10) || tempo, 40, 200);
    swingAmount = clamp(parseInt(saved.swing, 10) || swingAmount, 0, 70);
    if (Number.isFinite(Number(saved.velocity))) velocity = clamp(parseInt(saved.velocity, 10), 10, 100) / 100;
    if (Number.isFinite(Number(saved.volume))) volume = clamp(parseInt(saved.volume, 10), 0, 100) / 100;
    setStrumMode(normalizeMode(saved.mode, strumMode));
    updateTempoUI();
    updateSwingUI();
    updateVelocityUI();
    updateVolumeUI();
    if (masterGain) masterGain.gain.value = volume;
    playStyle = normalizePlayStyle(saved.playStyle, 'custom');
    pickPatternText = normalizePickPatternText(saved.pickPattern || '');
    pickBeats = parsePickBeatsLoose(saved.pickBeats, 0);
    pickThenMode = normalizeMode(saved.pickThenMode, 'strum-down');
    updatePlayStyleUI();
    updatePickingUI();
    singleString = parseSingleStringLoose(saved.singleString);
    updateSingleStringUI();
    setActiveInstruments(saved.instruments ?? saved.guitarType ?? ['steel'], { quiet: true });
    initSteps(nextNumSteps);
    syncChordCountButtons();

    steps = steps.map((step, i) => {
      const loaded = saved.steps[i];
      if (!loaded) return step;
      const chord = CHORDS[loaded.chord] ? loaded.chord : step.chord;
      const override = Number.isInteger(loaded.strumOverride) && loaded.strumOverride >= 0 && loaded.strumOverride <= 3
        ? loaded.strumOverride
        : null;
      const safeOverride = !PLAYABLE_CHORDS.includes(chord) ? null : override;
      const modeOverride = normalizeMode(loaded.modeOverride, null);
      const singleStringOverride = parseSingleStringLoose(loaded.singleStringOverride);
      const pickPattern = normalizePickPatternText(loaded.pickPattern || '') || null;
      const pickBeatsValue = parsePickBeatsLoose(loaded.pickBeats, null);
      const pickThenModeValue = normalizeMode(loaded.pickThenMode, null);
      const vel = Number.isFinite(loaded.vel) ? clamp(Math.round(loaded.vel), 0, 100)
        : (Number.isFinite(loaded.velocity) ? clamp(Math.round(loaded.velocity), 0, 100) : null);
      const accent = Number.isFinite(loaded.accent) ? +loaded.accent : null;
      const humanizeVel = Number.isFinite(loaded.humanizeVel) ? +loaded.humanizeVel : null;
      const pushMs = Number.isFinite(loaded.pushMs) ? +loaded.pushMs : null;
      const swingOverride = Number.isFinite(loaded.swingOverride) ? clamp(Math.round(loaded.swingOverride), 0, 70) : null;
      const hits = Array.isArray(loaded.hits)
        ? loaded.hits.map(h => ({
            type: ['down', 'up', 'mute', 'arp'].includes(h?.type) ? h.type : 'down',
            vel: Number.isFinite(h?.vel) ? clamp(Math.round(h.vel), 0, 100) : null,
            swing: Number.isFinite(h?.swing) ? +h.swing : null,
            spread: Number.isFinite(h?.spread) ? +h.spread : null,
            take: Number.isFinite(h?.take) ? +h.take : null,
          }))
        : null;
      const riff = (loaded.riff && typeof loaded.riff === 'object')
        ? {
            string: parseSingleStringLoose(loaded.riff.string) ?? 2,
            frets: Array.isArray(loaded.riff.frets) ? loaded.riff.frets.map(f => Math.max(0, Math.round(f))) : [],
            slide: Boolean(loaded.riff.slide),
            hammer: Boolean(loaded.riff.hammer),
            riffVel: Number.isFinite(loaded.riff.riffVel) ? clamp(Math.round(loaded.riff.riffVel), 0, 100) : null,
            riffHumanize: Number.isFinite(loaded.riff.riffHumanize) ? +loaded.riff.riffHumanize : null,
          }
        : null;
      const riffBeats = Number.isFinite(loaded.riffBeats) ? clamp(Math.round(loaded.riffBeats), 1, 4) : null;
      return { chord, strumOverride: safeOverride, modeOverride, singleStringOverride, pickPattern, pickBeats: pickBeatsValue, pickThenMode: pickThenModeValue, vel, accent, humanizeVel, pushMs, swingOverride, hits, riff, riffBeats };
    });

    renderSteps();
    currentStep = 0;
    updateChordDisplay(steps[0] ? steps[0].chord : '—');
    return true;
  } catch (err) {
    return false;
  }
}

function normalizeChordName(chord, fallback = 'Am') {
  if (typeof chord !== 'string') return fallback;
  const c = chord.trim();
  return CHORDS[c] ? c : fallback;
}

function parseIntegerInRange(value, fieldName, min, max) {
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} має бути цілим числом`);
  }
  if (value < min || value > max) {
    throw new Error(`${fieldName} має бути в діапазоні ${min}..${max}`);
  }
  return value;
}

function parseNumberInRange(value, fieldName, min, max) {
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} має бути числом`);
  }
  if (value < min || value > max) {
    throw new Error(`${fieldName} має бути в діапазоні ${min}..${max}`);
  }
  return value;
}

function parseModeStrict(value, fieldName) {
  if (typeof value !== 'string' || !AVAILABLE_MODES.includes(value)) {
    throw new Error(`${fieldName} має бути одним із дозволених режимів`);
  }
  return value;
}

function parseChordStrict(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} має бути рядком`);
  }
  let v = value.trim();
  if (!v) throw new Error(`${fieldName} пустий`);

  // Use normalizeChordToken — it handles casing, enharmonics, suffix aliases, and synthesis
  const resolved = normalizeChordToken(v);
  if (resolved && CHORDS[resolved]) return resolved;

  throw new Error(`${fieldName} має бути одним із дозволених акордів`);
}

function parseSingleStringStrict(value, fieldName) {
  return parseIntegerInRange(value, fieldName, 1, 6);
}

function parsePlayStyleStrict(value, fieldName = 'playStyle') {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const safe = normalizePlayStyle(value, null);
  if (!safe) throw new Error(`${fieldName} must be one of supported styles`);
  return safe;
}

function parsePickPatternStrict(value, fieldName) {
  if (typeof value !== 'string' && !Array.isArray(value)) {
    throw new Error(`${fieldName} must be a string or array`);
  }
  const normalized = normalizePickPatternText(value);
  if (!normalized) throw new Error(`${fieldName} has no valid string pattern`);
  return normalized;
}

function parseInstrumentListStrict(value, fieldName = 'instruments') {
  const allowedPreview = formatAllowedInstruments(24);
  const source = Array.isArray(value)
    ? value
    : (value === undefined || value === null ? [] : [value]);

  if (source.length === 0) {
    throw new Error(`${fieldName} must contain 1..4 instruments`);
  }

  const normalized = [];
  source.forEach((item, index) => {
    const safeType = normalizeInstrumentType(item);
    if (!safeType) {
      throw new Error(`${fieldName}[${index}] must be one of: ${allowedPreview}`);
    }
    if (!normalized.includes(safeType)) normalized.push(safeType);
  });

  if (normalized.length > 4) {
    throw new Error(`${fieldName} supports at most 4 instruments`);
  }

  if (normalized.length === 0) {
    throw new Error(`${fieldName} must contain at least one valid instrument`);
  }
  return normalized;
}

function parseScriptStep(entry, index = 0) {
  const stepRef = `steps[${index}]`;

  if (typeof entry === 'string') {
    return {
      chord: parseChordStrict(entry, stepRef),
      strumOverride: null,
      modeOverride: null,
      singleStringOverride: null,
      pickPattern: null,
      pickBeats: null,
      pickThenMode: null,
    };
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${stepRef} має бути рядком акорду або об'єктом`);
  }

  if (!Object.prototype.hasOwnProperty.call(entry, 'chord')) {
    throw new Error(`${stepRef}.chord обов'язковий`);
  }

  const chord = parseChordStrict(entry.chord, `${stepRef}.chord`);
  if (entry.mode !== undefined) {
    throw new Error(`${stepRef}.mode не підтримується, використовуй modeOverride`);
  }
  const modeOverride = entry.modeOverride === undefined
    ? null
    : parseModeStrict(entry.modeOverride, `${stepRef}.modeOverride`);

  let strumOverride = null;
  if (entry.strumOverride !== undefined) {
    strumOverride = parseIntegerInRange(entry.strumOverride, `${stepRef}.strumOverride`, 0, 3);
  }

  let singleStringOverride = null;
  const stepSingleString = entry.singleStringOverride ?? entry.singleString;
  if (stepSingleString !== undefined) {
    singleStringOverride = parseSingleStringStrict(stepSingleString, `${stepRef}.singleStringOverride`);
  }

  let pickPattern = null;
  if (entry.pickPattern !== undefined) {
    pickPattern = parsePickPatternStrict(entry.pickPattern, `${stepRef}.pickPattern`);
  }

  let pickBeatsValue = null;
  if (entry.pickBeats !== undefined) {
    pickBeatsValue = parseNumberInRange(Number(entry.pickBeats), `${stepRef}.pickBeats`, 0, 4);
  }

  let pickThenModeValue = null;
  if (entry.pickThenMode !== undefined) {
    pickThenModeValue = parseModeStrict(entry.pickThenMode, `${stepRef}.pickThenMode`);
  }

  if (!PLAYABLE_CHORDS.includes(chord) && strumOverride !== null) {
    throw new Error(`${stepRef}.strumOverride не можна задавати для паузи`);
  }
  if (!PLAYABLE_CHORDS.includes(chord) && pickPattern) {
    throw new Error(`${stepRef}.pickPattern не можна задавати для паузи`);
  }

  // Optional per-step dynamics/timing
  let vel = null;
  const stepVelRaw = entry.vel !== undefined ? entry.vel : entry.velocity;
  if (stepVelRaw !== undefined) {
    vel = parseIntegerInRange(Math.round(stepVelRaw), `${stepRef}.vel`, 0, 100);
  }

  let accent = null;
  if (entry.accent !== undefined) {
    accent = parseNumberInRange(Number(entry.accent), `${stepRef}.accent`, 0, 1.5);
  }

  let humanizeVel = null;
  if (entry.humanizeVel !== undefined) {
    humanizeVel = parseNumberInRange(Number(entry.humanizeVel), `${stepRef}.humanizeVel`, 0, 1);
  }

  // Per-step push / swing override
  let pushMs = null;
  if (entry.pushMs !== undefined) {
    pushMs = parseNumberInRange(Number(entry.pushMs), `${stepRef}.pushMs`, -30, 30);
  }

  let swingOverride = null;
  if (entry.swingOverride !== undefined) {
    swingOverride = parseIntegerInRange(Math.round(entry.swingOverride), `${stepRef}.swingOverride`, 0, 70);
  }

  // Hits scripting (optional array of per-hit objects)
  let hits = null;
  if (entry.hits !== undefined) {
    if (!Array.isArray(entry.hits) || entry.hits.length === 0) throw new Error(`${stepRef}.hits має бути непорожнім масивом`);
    hits = entry.hits.map((h, hi) => {
      if (!h || typeof h !== 'object') throw new Error(`${stepRef}.hits[${hi}] має бути об'єктом`);
      const type = ['down','up','mute','arp'].includes(h.type) ? h.type : 'down';
      const hvel = h.vel === undefined ? null : parseIntegerInRange(Math.round(h.vel), `${stepRef}.hits[${hi}].vel`, 0, 100);
      const hswing = h.swing === undefined ? null : parseNumberInRange(Number(h.swing), `${stepRef}.hits[${hi}].swing`, -1, 1);
      const hspread = h.spread === undefined ? null : parseNumberInRange(Number(h.spread), `${stepRef}.hits[${hi}].spread`, 0, 0.03);
      const htake = h.take === undefined ? null : parseNumberInRange(Number(h.take), `${stepRef}.hits[${hi}].take`, 0, 1);
      return { type, vel: hvel, swing: hswing, spread: hspread, take: htake };
    });
  }

  // Riff (extended)
  let riff = null;
  if (entry.riff !== undefined) {
    if (!entry.riff || typeof entry.riff !== 'object') throw new Error(`${stepRef}.riff має бути об'єктом`);
    const s = entry.riff.string === undefined ? 2 : parseIntegerInRange(Math.round(entry.riff.string), `${stepRef}.riff.string`, 1, 6);
    const frets = Array.isArray(entry.riff.frets) ? entry.riff.frets.map(f => Math.max(0, Math.round(f))) : [];
    const slide = Boolean(entry.riff.slide);
    const hammer = Boolean(entry.riff.hammer);
    const riffVel = entry.riff.riffVel === undefined ? null : parseIntegerInRange(Math.round(entry.riff.riffVel), `${stepRef}.riff.riffVel`, 0, 100);
    const riffHumanize = entry.riff.riffHumanize === undefined ? null : parseNumberInRange(Number(entry.riff.riffHumanize), `${stepRef}.riff.riffHumanize`, 0, 1);
    riff = { string: s, frets, slide, hammer, riffVel, riffHumanize };
  }

  let riffBeats = null;
  if (entry.riffBeats !== undefined) {
    riffBeats = parseIntegerInRange(Math.round(entry.riffBeats), `${stepRef}.riffBeats`, 1, 4);
  }

  return {
    chord,
    strumOverride,
    modeOverride,
    singleStringOverride,
    pickPattern,
    pickBeats: pickBeatsValue,
    pickThenMode: pickThenModeValue,
    vel,
    accent,
    humanizeVel,
    pushMs,
    swingOverride,
    hits,
    riff,
    riffBeats,
  };
}

function validateScriptObject(script) {
  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    throw new Error('JSON має бути обʼєктом');
  }

  const requiredFields = [
    'version',
    'song',
    'tempo',
    'volume',
    'velocity',
    'swing',
    'mode',
    'numSteps',
    'steps',
  ];

  requiredFields.forEach(field => {
    if (!Object.prototype.hasOwnProperty.call(script, field)) {
      throw new Error(`Відсутнє обов'язкове поле: ${field}`);
    }
  });

  const version = parseIntegerInRange(script.version, 'version', SCRIPT_VERSION, SCRIPT_VERSION);
  if (typeof script.song !== 'string') {
    throw new Error('song має бути рядком');
  }

  const tempoValue = parseIntegerInRange(script.tempo, 'tempo', 40, 200);
  const volumeValue = parseIntegerInRange(script.volume, 'volume', 0, 100);
  const velocityValue = parseIntegerInRange(script.velocity, 'velocity', 10, 100);
  const swingValue = parseIntegerInRange(script.swing, 'swing', 0, 70);

  const instrumentsInput = script.instruments !== undefined
    ? script.instruments
    : (script.guitarType !== undefined ? [script.guitarType] : null);
  if (instrumentsInput === null) {
    throw new Error('Missing instruments: provide instruments (1..4) or legacy guitarType');
  }
  const instrumentsValue = parseInstrumentListStrict(instrumentsInput, 'instruments');

  // Optional global humanize/mix fields
  const humanizeTimeMsValue = script.humanizeTimeMs === undefined ? 10 : parseNumberInRange(Number(script.humanizeTimeMs), 'humanizeTimeMs', 0, 20);
  const humanizeVelPctValue = script.humanizeVelPct === undefined ? 8 : parseNumberInRange(Number(script.humanizeVelPct), 'humanizeVelPct', 0, 20);
  const tightnessValue = script.tightness === undefined ? 0.85 : parseNumberInRange(Number(script.tightness), 'tightness', 0, 1);

  const mixValue = (script.mix && typeof script.mix === 'object') ? script.mix : null;

  // Optional song structure
  const sectionsValue = Array.isArray(script.sections) ? script.sections.slice() : null;
  const loopValue = script.loop && typeof script.loop === 'object' ? script.loop : null;
  const arrangementNotesValue = typeof script.arrangementNotes === 'string' ? script.arrangementNotes : null;

  const capoValue = script.capo === undefined ? 0 : parseIntegerInRange(Math.round(script.capo), 'capo', 0, 12);
  const tuningValue = Array.isArray(script.tuning) ? script.tuning.slice() : null;

  const modeValue = parseModeStrict(script.mode, 'mode');
  const playStyleValue = script.playStyle === undefined
    ? 'custom'
    : parsePlayStyleStrict(script.playStyle, 'playStyle');
  const pickPatternValue = script.pickPattern === undefined
    ? ''
    : normalizePickPatternText(script.pickPattern);
  const pickBeatsValue = script.pickBeats === undefined
    ? 0
    : parseNumberInRange(Number(script.pickBeats), 'pickBeats', 0, 4);
  const pickThenModeValue = script.pickThenMode === undefined
    ? 'strum-down'
    : parseModeStrict(script.pickThenMode, 'pickThenMode');
  const singleStringValue = script.singleString === undefined
    ? null
    : parseSingleStringStrict(script.singleString, 'singleString');

  if (!Array.isArray(script.steps)) {
    throw new Error('steps має бути масивом');
  }

  const parsedSteps = script.steps.map((step, i) => parseScriptStep(step, i));
  // Accept scripts where declared numSteps may differ from actual steps length.
  // Use the actual parsed steps length as canonical, clamped to allowed range.
  const numStepsValue = clamp(parsedSteps.length, MIN_STEPS, MAX_STEPS);

  return {
    version,
    song: script.song,
    tempo: tempoValue,
    volume: volumeValue,
    velocity: velocityValue,
    swing: swingValue,
    guitarType: instrumentsValue[0],
    instruments: instrumentsValue,
    mode: modeValue,
    playStyle: playStyleValue,
    pickPattern: pickPatternValue,
    pickBeats: pickBeatsValue,
    pickThenMode: pickThenModeValue,
    singleString: singleStringValue,
    numSteps: numStepsValue,
    steps: parsedSteps,
    humanizeTimeMs: humanizeTimeMsValue,
    humanizeVelPct: humanizeVelPctValue,
    tightness: tightnessValue,
    mix: mixValue,
    sections: sectionsValue,
    loop: loopValue,
    arrangementNotes: arrangementNotesValue,
    capo: capoValue,
    tuning: tuningValue,
  };
}

function isLikelyMetadataLine(line) {
  if (!line || typeof line !== 'string') return false;
  const normalized = line.toLowerCase().replace(/[\[\]]/g, '').trim();
  if (!normalized) return false;

  if (/^(difficulty|tuning|chords?|strumming|general pattern|verse|intro|chorus|solo|outro|interlude|bridge|from|page)\b/.test(normalized)) {
    return true;
  }
  if (/^the\s+unforgiven\b/.test(normalized)) return true;
  if (normalized.includes('bpm') && normalized.split(/\s+/).length <= 6) return true;

  if (normalized.includes(':')) {
    const left = normalized.split(':')[0].trim();
    if (left && !normalizeChordToken(left)) return true;
  }
  return false;
}

function normalizeChordToken(token) {
  if (typeof token !== 'string') return null;
  const clean = token
    .replace(/[\[\]{}()]/g, '')
    .replace(/[|,;]+/g, '')
    .replace(/[♭в™­]/g, 'b')
    .replace(/[♯в™Ї]/g, '#')
    .trim();
  if (!clean) return null;

  // Direct match first
  if (CHORDS[clean]) return clean;

  // Accept chord-like tokens with extended suffixes
  const m = clean.match(/^([A-Ga-g])([#b]?)(m7|maj7|min7|m|maj|min|7|sus2|sus4|sus|add9|dim|aug|5)?$/i);
  if (!m) return null;

  const root = `${m[1].toUpperCase()}${m[2]}`;
  const rawTail = (m[3] || '').toLowerCase();

  // Normalize suffix aliases
  const suffixMap = {
    '': '', 'm': 'm', 'min': 'm', 'maj': '', '7': '7',
    'm7': 'm7', 'min7': 'm7', 'maj7': 'maj7',
    'sus2': 'sus2', 'sus4': 'sus4', 'sus': 'sus4',
    'add9': 'add9', 'dim': 'dim', 'aug': 'aug', '5': '5',
  };
  const suffix = suffixMap[rawTail] !== undefined ? suffixMap[rawTail] : rawTail;
  const fullName = root + suffix;

  if (CHORDS[fullName]) return fullName;

  // Enharmonic equivalents
  const enharmonic = {
    'A#': 'Bb', 'Bb': 'A#',
    'C#': 'Db', 'Db': 'C#',
    'D#': 'Eb', 'Eb': 'D#',
    'F#': 'Gb', 'Gb': 'F#',
    'G#': 'Ab', 'Ab': 'G#',
  };

  const mappedRoot = enharmonic[root];
  if (mappedRoot) {
    const mapped = mappedRoot + suffix;
    if (CHORDS[mapped]) return mapped;
  }

  // Try to dynamically create via createSyntheticChord
  const created = createSyntheticChord(fullName);
  if (created) return fullName;
  if (mappedRoot) {
    const createdEnh = createSyntheticChord(mappedRoot + suffix);
    if (createdEnh) return mappedRoot + suffix;
  }

  return null;
}

function parseChordSequenceFromText(text) {
  if (!text || typeof text !== 'string') return [];

  const lines = text
    .replace(/\r/g, '')
    .replace(/-{2,}/g, ' ')
    .split('\n');

  const parsed = [];
  lines.forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;

    // TAB rows are handled by parseTabBlocksToChords.
    if (/^\s*[EADGBe]\s*[|:]/.test(rawLine)) return;
    if (isLikelyMetadataLine(line)) return;

    const tokens = line.split(/[\s/\\|,:;]+/).filter(Boolean);
    if (!tokens.length) return;

    const lineChords = [];
    const nonChordTokens = [];
    tokens.forEach(token => {
      const chord = normalizeChordToken(token);
      if (chord) lineChords.push(chord);
      else nonChordTokens.push(token);
    });

    if (!lineChords.length) return;

    if (lineChords.length === 1 && nonChordTokens.length > 0) {
      const repeatOnly = nonChordTokens.every(token => /^(x\d+|\d+x|x|\*+)$/.test(token.toLowerCase()));
      if (!repeatOnly) return;
    }

    if (nonChordTokens.length > lineChords.length) return;
    parsed.push(...lineChords);
  });

  return parsed;
}

function getChordFretPattern(chordName) {
  const chord = CHORDS[chordName];
  if (!chord || !Array.isArray(chord.notes)) return [null, null, null, null, null, null];
  const pattern = [null, null, null, null, null, null];
  chord.notes.forEach(note => {
    const lowToHighIndex = 5 - note.s;
    pattern[lowToHighIndex] = note.f;
  });
  return pattern;
}

function scoreFretPattern(candidate, target) {
  let score = 0;
  for (let i = 0; i < 6; i++) {
    const a = candidate[i];
    const b = target[i];
    if (a === null && b === null) continue;
    if (a === null || b === null) {
      score += 1.35;
      continue;
    }
    score += Math.abs(a - b);
    if (a === b) score -= 0.12;
  }
  return score;
}

function matchTabPatternToChord(lowToHighFrets) {
  let bestChord = null;
  let bestScore = Number.POSITIVE_INFINITY;

  PLAYABLE_CHORDS.forEach(chordName => {
    const target = getChordFretPattern(chordName);
    const score = scoreFretPattern(lowToHighFrets, target);
    if (score < bestScore) {
      bestScore = score;
      bestChord = chordName;
    }
  });

  return bestScore <= 4.6 ? bestChord : null;
}

function parseFretFromTabSegment(segment) {
  if (!segment) return null;
  const nums = [...segment.matchAll(/\d{1,2}/g)].map(m => parseInt(m[0], 10));
  if (nums.length === 0) return null;

  const freq = new Map();
  nums.forEach(n => freq.set(n, (freq.get(n) || 0) + 1));
  let best = nums[0];
  let bestCount = 0;
  freq.forEach((count, num) => {
    if (count > bestCount) {
      best = num;
      bestCount = count;
    }
  });
  return best;
}

function parseTabBlocksToChords(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.replace(/\r/g, '').split('\n');
  const parsedLines = lines
    .map(line => {
      const m = line.match(/^\s*([EADGBe])\s*[|:]\s*(.*)$/);
      if (!m) return null;
      return { name: m[1].toUpperCase(), body: m[2] };
    })
    .filter(Boolean);

  if (parsedLines.length < 6) return [];

  const chords = [];
  for (let i = 0; i <= parsedLines.length - 6; i++) {
    const block = parsedLines.slice(i, i + 6);
    const names = block.map(item => item.name);
    const isStandardOrder =
      names[0] === 'E' &&
      names[1] === 'B' &&
      names[2] === 'G' &&
      names[3] === 'D' &&
      names[4] === 'A' &&
      names[5] === 'E';
    if (!isStandardOrder) continue;

    const barsByString = block.map(item => item.body.split('|'));
    const barsCount = Math.max(...barsByString.map(parts => parts.length));

    for (let bar = 0; bar < barsCount; bar++) {
      const highToLow = barsByString.map(parts => parseFretFromTabSegment(parts[bar] || ''));
      if (highToLow.every(v => v === null)) continue;
      const lowToHigh = [...highToLow].reverse();
      const matched = matchTabPatternToChord(lowToHigh);
      chords.push(matched || '—');
    }

    i += 5;
  }

  return chords;
}

function parseTabOrChordProgression(text) {
  const fromTab = parseTabBlocksToChords(text);
  if (fromTab.length >= 2) return fromTab;
  const fromTokens = parseChordSequenceFromText(text);
  if (fromTokens.length >= 2) return fromTokens;
  return fromTab.length ? fromTab : fromTokens;
}

function compressProgression(chords, maxLen = MAX_STEPS) {
  if (!Array.isArray(chords)) return [];
  if (chords.length <= maxLen) return [...chords];
  const compressed = [];
  for (let i = 0; i < maxLen; i++) {
    const idx = Math.floor((i * chords.length) / maxLen);
    compressed.push(chords[idx]);
  }
  return compressed;
}

function collectPromptSettings() {
  const songName = document.getElementById('songNameInput').value.trim();
  const style = document.getElementById('songStyleInput').value.trim();
  const mood = document.getElementById('songMoodInput').value.trim();
  const key = document.getElementById('songKeyInput').value.trim();
  const bars = parseInt(document.getElementById('songBarsInput').value, 10) || 16;
  const difficulty = document.getElementById('songDifficultyInput').value;
  const bpmHint = parseInt(document.getElementById('songBpmHintInput').value, 10);
  const similarityRaw = parseInt(document.getElementById('songSimilarityInput')?.value, 10);
  const tabText = document.getElementById('tabInput').value.trim();
  const parsedTabProgression = parseTabOrChordProgression(tabText);
  const instruments = [...getActiveInstrumentList()];
  const playStyleValue = normalizePlayStyle(document.getElementById('playStyleSelect')?.value || playStyle, 'custom');
  const pickPatternValue = normalizePickPatternText(document.getElementById('pickPatternInput')?.value || pickPatternText || '');
  const pickBeatsValue = parsePickBeatsLoose(document.getElementById('pickBeatsInput')?.value, pickBeats);
  const pickThenModeValue = normalizeMode(document.getElementById('pickThenModeSelect')?.value || pickThenMode, 'strum-down');
  const smartTagRiffs = Boolean(document.getElementById('smartTagRiffs')?.checked);
  const smartTagComplexChords = Boolean(document.getElementById('smartTagComplexChords')?.checked);
  const smartTagFinalLift = Boolean(document.getElementById('smartTagFinalLift')?.checked);

  return {
    songName,
    style,
    mood,
    key,
    bars,
    difficulty,
    bpmHint: Number.isFinite(bpmHint) ? bpmHint : null,
    similarityPct: Number.isFinite(similarityRaw) ? clamp(Math.round(similarityRaw), 0, 100) : 100,
    tabText,
    parsedTabProgression,
    instruments,
    playStyle: playStyleValue,
    pickPattern: pickPatternValue,
    pickBeats: pickBeatsValue,
    pickThenMode: pickThenModeValue,
    smartTags: {
      addRiffs: smartTagRiffs,
      complexChords: smartTagComplexChords,
      finalLift: smartTagFinalLift,
    },
  };
}

/**
 * Strip JS-style comments from a JSON-like string without breaking strings.
 * Handles // line comments, /* block comments *​/, and bare ... ellipsis lines.
 */
function stripJsonComments(str) {
  let result = '';
  let i = 0;
  const len = str.length;
  while (i < len) {
    const ch = str[i];
    // String literal — copy as-is, respecting escapes
    if (ch === '"') {
      let j = i + 1;
      while (j < len) {
        if (str[j] === '\\') { j += 2; continue; }
        if (str[j] === '"') { j++; break; }
        j++;
      }
      result += str.slice(i, j);
      i = j;
      continue;
    }
    // Block comment /* ... */
    if (ch === '/' && str[i + 1] === '*') {
      const end = str.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    // Line comment //
    if (ch === '/' && str[i + 1] === '/') {
      const nl = str.indexOf('\n', i + 2);
      i = nl === -1 ? len : nl;
      continue;
    }
    // Bare ellipsis ("...") outside strings — skip
    if (ch === '.' && str[i + 1] === '.' && str[i + 2] === '.') {
      i += 3;
      continue;
    }
    result += ch;
    i++;
  }
  // Remove trailing commas before } or ] (common after stripping comments)
  return result.replace(/,\s*([}\]])/g, '$1');
}

function extractJsonObjectFromText(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty text');
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let raw = (fencedMatch ? fencedMatch[1] : text).trim();

  // Remove accidental code-fence markers inside the JSON and non-printable control chars
  raw = raw.replace(/```/g, '').replace(/\u0000/g, '').trim();

  // Strip JS-style comments and ellipsis so users can paste annotated JSON
  raw = stripJsonComments(raw);

  try {
    return JSON.parse(raw);
  } catch (err) {
    // Try to extract the first {...} block and also strip stray backticks
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const candidate = raw.slice(start, end + 1).replace(/```/g, '').trim();
      try { return JSON.parse(candidate); } catch (err2) { /* fallthrough */ }
    }
    throw new Error('No valid JSON found');
  }
}

function autoFixScriptObject(script) {
  if (!script || typeof script !== 'object') throw new Error('Cannot auto-fix: invalid script');

  const fixed = Object.assign({}, script);
  if (typeof fixed.song !== 'string' || !fixed.song.trim()) {
    fixed.song = (typeof fixed.title === 'string' && fixed.title.trim()) ? fixed.title.trim() : 'Untitled Song';
  } else {
    fixed.song = fixed.song.trim();
  }
  if (fixed.swing === undefined && fixed.swingAmount !== undefined) fixed.swing = fixed.swingAmount;
  if (fixed.tempo === undefined && fixed.bpm !== undefined) fixed.tempo = fixed.bpm;
  if (fixed.velocity === undefined && fixed.vel !== undefined) fixed.velocity = fixed.vel;
  // Ensure numeric fields
  fixed.version = Number.isInteger(fixed.version) ? fixed.version : SCRIPT_VERSION;
  fixed.tempo = Number.isFinite(fixed.tempo) ? clamp(Math.round(fixed.tempo), 40, 200) : tempo;
  fixed.volume = Number.isFinite(fixed.volume) ? clamp(Math.round(fixed.volume), 0, 100) : Math.round(volume * 100);
  fixed.velocity = Number.isFinite(fixed.velocity) ? clamp(Math.round(fixed.velocity), 10, 100) : Math.round(velocity * 100);
  fixed.swing = Number.isFinite(fixed.swing) ? clamp(Math.round(fixed.swing), 0, 70) : swingAmount;

  // Instruments fallback
  try { fixed.instruments = parseInstrumentListStrict(fixed.instruments ?? fixed.guitarType, 'instruments'); } catch (e) { fixed.instruments = [guitarType || 'steel']; }

  const firstStepMode = Array.isArray(fixed.steps)
    ? normalizeMode(fixed.steps.find(s => s && typeof s === 'object' && s.modeOverride)?.modeOverride, null)
    : null;
  fixed.mode = normalizeMode(fixed.mode, firstStepMode || strumMode);
  fixed.playStyle = normalizePlayStyle(fixed.playStyle, playStyle || 'custom');
  fixed.pickPattern = normalizePickPatternText(fixed.pickPattern || pickPatternText || '');
  fixed.pickBeats = parsePickBeatsLoose(fixed.pickBeats, pickBeats);
  fixed.pickThenMode = normalizeMode(fixed.pickThenMode, pickThenMode || strumMode);

  let desired = clamp(parseInt(fixed.numSteps, 10) || (Array.isArray(fixed.steps) ? fixed.steps.length : 8), MIN_STEPS, MAX_STEPS);
  fixed.numSteps = desired;

  const rawSteps = Array.isArray(fixed.steps) ? fixed.steps.slice() : [];
  const normalized = [];
  rawSteps.forEach((entry, i) => {
    try {
      if (typeof entry === 'string') {
        const c = normalizeChordToken(entry) || '—';
        normalized.push({ chord: c });
      } else if (entry && typeof entry === 'object') {
        const chordName = (entry.chord && normalizeChordToken(entry.chord)) || '—';
        const st = Number.isInteger(entry.strumOverride) ? entry.strumOverride : null;
        const mo = entry.modeOverride ? normalizeMode(entry.modeOverride, null) : null;
        const ss = entry.singleStringOverride !== undefined ? parseSingleStringLoose(entry.singleStringOverride) : null;
        const pp = entry.pickPattern ? normalizePickPatternText(entry.pickPattern) : null;
        const pb = entry.pickBeats !== undefined ? parsePickBeatsLoose(entry.pickBeats, null) : null;
        const pm = entry.pickThenMode ? normalizeMode(entry.pickThenMode, null) : null;
        const vel = Number.isFinite(entry.vel) ? clamp(Math.round(entry.vel), 0, 100)
          : (Number.isFinite(entry.velocity) ? clamp(Math.round(entry.velocity), 0, 100) : null);
        const accent = Number.isFinite(entry.accent) ? +entry.accent : null;
        const humanizeVel = Number.isFinite(entry.humanizeVel) ? +entry.humanizeVel : null;
        const pushMs = Number.isFinite(entry.pushMs) ? +entry.pushMs : null;
        const swingOverride = Number.isFinite(entry.swingOverride) ? clamp(Math.round(entry.swingOverride), 0, 70) : null;
        const hits = Array.isArray(entry.hits)
          ? entry.hits.map(h => ({
              type: ['down', 'up', 'mute', 'arp'].includes(h?.type) ? h.type : 'down',
              vel: Number.isFinite(h?.vel) ? clamp(Math.round(h.vel), 0, 100) : null,
              swing: Number.isFinite(h?.swing) ? +h.swing : null,
              spread: Number.isFinite(h?.spread) ? +h.spread : null,
              take: Number.isFinite(h?.take) ? +h.take : null,
            }))
          : null;
        const riff = (entry.riff && typeof entry.riff === 'object')
          ? {
              string: parseSingleStringLoose(entry.riff.string) ?? 2,
              frets: Array.isArray(entry.riff.frets) ? entry.riff.frets.map(f => Math.max(0, Math.round(f))) : [],
              slide: Boolean(entry.riff.slide),
              hammer: Boolean(entry.riff.hammer),
              riffVel: Number.isFinite(entry.riff.riffVel) ? clamp(Math.round(entry.riff.riffVel), 0, 100) : null,
              riffHumanize: Number.isFinite(entry.riff.riffHumanize) ? +entry.riff.riffHumanize : null,
            }
          : null;
        const riffBeats = Number.isFinite(entry.riffBeats) ? clamp(Math.round(entry.riffBeats), 1, 4) : null;
        normalized.push({
          chord: chordName,
          strumOverride: st,
          modeOverride: mo,
          singleStringOverride: ss,
          pickPattern: pp,
          pickBeats: pb,
          pickThenMode: pm,
          vel,
          accent,
          humanizeVel,
          pushMs,
          swingOverride,
          hits,
          riff,
          riffBeats,
        });
      }
    } catch (e) {
      // skip invalid step
    }
  });

  if (normalized.length === 0) {
    // if nothing parsed, fill with pauses
    for (let i = 0; i < desired; i++) normalized.push({ chord: '—' });
  }

  // Repeat or truncate to match desired length
  const out = Array.from({ length: desired }, (_, i) => {
    const src = normalized[i % normalized.length] || { chord: '—' };
    return {
      chord: normalizeChordName(src.chord, '—'),
      strumOverride: Number.isInteger(src.strumOverride) ? src.strumOverride : null,
      modeOverride: src.modeOverride || null,
      singleStringOverride: src.singleStringOverride ?? null,
      pickPattern: src.pickPattern || null,
      pickBeats: parsePickBeatsLoose(src.pickBeats, null),
      pickThenMode: src.pickThenMode || null,
      vel: Number.isFinite(src.vel) ? clamp(Math.round(src.vel), 0, 100) : null,
      accent: Number.isFinite(src.accent) ? +src.accent : null,
      humanizeVel: Number.isFinite(src.humanizeVel) ? +src.humanizeVel : null,
      pushMs: Number.isFinite(src.pushMs) ? +src.pushMs : null,
      swingOverride: Number.isFinite(src.swingOverride) ? clamp(Math.round(src.swingOverride), 0, 70) : null,
      hits: Array.isArray(src.hits) ? src.hits.map(h => ({ type: h.type, vel: h.vel, swing: h.swing, spread: h.spread, take: h.take })) : null,
      riff: src.riff && typeof src.riff === 'object'
        ? {
            string: parseSingleStringLoose(src.riff.string) ?? 2,
            frets: Array.isArray(src.riff.frets) ? src.riff.frets.map(f => Math.max(0, Math.round(f))) : [],
            slide: Boolean(src.riff.slide),
            hammer: Boolean(src.riff.hammer),
            riffVel: Number.isFinite(src.riff.riffVel) ? clamp(Math.round(src.riff.riffVel), 0, 100) : null,
            riffHumanize: Number.isFinite(src.riff.riffHumanize) ? +src.riff.riffHumanize : null,
          }
        : null,
      riffBeats: Number.isFinite(src.riffBeats) ? clamp(Math.round(src.riffBeats), 1, 4) : null,
    };
  });

  fixed.steps = out;
  // Ensure we don't keep strumOverride for unplayable steps (pauses)
  try {
    fixed.steps.forEach(s => {
      if (!PLAYABLE_CHORDS.includes(s.chord)) s.strumOverride = null;
    });
  } catch (e) {
    // ignore
  }
  return fixed;
}

function getSystemContext(options = {}) {
  const barsValue = clamp(Number.isFinite(options.bars) ? options.bars : numSteps, MIN_STEPS, MAX_STEPS);
  const suggestedTempo = Number.isFinite(options.bpmHint)
    ? clamp(Math.round(options.bpmHint), 40, 200)
    : clamp(Math.round(tempo), 40, 200);
  const similarityPct = clamp(Number.isFinite(options.similarityPct) ? Math.round(options.similarityPct) : 100, 0, 100);
  const contextInstruments = sanitizeInstrumentList(
    Array.isArray(options.instruments) && options.instruments.length ? options.instruments : getActiveInstrumentList(),
    'steel'
  );
  const contextPlayStyle = normalizePlayStyle(options.playStyle || playStyle || 'custom', 'custom');
  const contextPickPattern = normalizePickPatternText(options.pickPattern || pickPatternText || '');
  const contextPickBeats = parsePickBeatsLoose(options.pickBeats, pickBeats);
  const contextPickThenMode = normalizeMode(options.pickThenMode || pickThenMode || strumMode, 'strum-down');

  return [
    'Current App State:',
    `- Tempo: ${clamp(Math.round(tempo), 40, 200)} BPM (suggested output tempo: ${suggestedTempo} BPM)`,
    `- Swing: ${clamp(Math.round(swingAmount), 0, 70)}%`,
    `- Humanize Time: ${clamp(Math.round(humanizeTimeMs), 0, 20)}ms`,
    `- Humanize Velocity: ${clamp(Math.round(humanizeVelPct), 0, 20)}%`,
    `- Tightness: ${Math.round(clamp(tightness, 0, 1) * 100) / 100}`,
    `- Active Instruments: ${contextInstruments.join(', ')}`,
    `- Current Play Style: ${contextPlayStyle}`,
    `- Current Base Mode: ${normalizeMode(strumMode, 'strum-down')}`,
    `- Pick Pattern: ${contextPickPattern || 'none'}`,
    `- Pick Beats: ${contextPickBeats}`,
    `- Pick Then Mode: ${contextPickThenMode}`,
    `- Similarity Target: ${similarityPct}%`,
    `- Requested Steps: ${barsValue}`,
    `- Available Modes: ${AVAILABLE_MODES.join(', ')}.`,
  ].join('\n');
}

function getSmartPromptInstructionLines(options = {}) {
  const difficulty = options.difficulty || 'medium';
  const smartTags = options.smartTags && typeof options.smartTags === 'object' ? options.smartTags : {};
  const styleText = `${options.style || ''} ${options.mood || ''}`.toLowerCase();
  const tempoHint = Number.isFinite(options.bpmHint) ? clamp(Math.round(options.bpmHint), 40, 200) : clamp(Math.round(tempo), 40, 200);
  const styleHint = normalizePlayStyle(options.playStyle || playStyle, 'custom');

  const addRiffs = Boolean(smartTags.addRiffs) || /(^|\W)(riff|hook|lead)(\W|$)/.test(styleText);
  const complexChords = Boolean(smartTags.complexChords) || /(^|\W)(jazz|neo|extended|complex|maj7|add9|sus|secondary)(\W|$)/.test(styleText);
  const finalLift = Boolean(smartTags.finalLift) || /(^|\W)(finale|build|lift|climax|outro)(\W|$)/.test(styleText);
  const isPunkLike = styleHint === 'non-stop-punk' || /(^|\W)(punk|hardcore|non[-\s]?stop)(\W|$)/.test(styleText);

  const lines = [];

  if (difficulty === 'easy') {
    lines.push('EASY: use open chords only (Am, Em, C, G, D, F, Dm, E, A). No riffs, no hits[].');
  }
  if (difficulty === 'advanced' || complexChords) {
    lines.push('ADVANCED: add 2-3 bars with sus2/sus4/add9/maj7/7. Use syncopated accents.');
  }
  if (difficulty === 'advanced' || addRiffs) {
    lines.push('RIFFS: add `riff` + `riffBeats` on 2-3 transition bars. riff.frets must be valid fret numbers 0-12.');
  }
  if (finalLift) {
    lines.push('LIFT: final 2 bars use denser pattern (e.g. pattern-12) and vel 90+.');
  }
  if (isPunkLike) {
    lines.push('PUNK: verse=pattern-8-mute, chorus=pattern-8. instruments=["electric","bass"]. swing 0-3. No arpeggio/slow-strum.');
  }
  if (tempoHint >= 150) {
    lines.push('FAST TEMPO: swing must be 0-3. Avoid arpeggio/slow-strum. Use pattern-8-mute or pattern-8.');
  }
  if (tempoHint <= 70) {
    lines.push('SLOW TEMPO: prefer arpeggio/fingerpick/slow-strum. Pattern modes sound choppy at low BPM.');
  }
  return lines;
}

function getSimilarityInstructionLines(similarityPct = 100, hasReference = false) {
  const pct = clamp(Math.round(similarityPct), 0, 100);

  if (pct >= 100) {
    return hasReference
      ? [
          '- Similarity target is 100%: preserve reference chord order, section contour, rhythmic density, and dynamic shape as closely as possible.',
          '- Keep harmonic substitutions minimal; do not replace core progression when a reference is provided.',
        ]
      : [
          '- Similarity target is 100%: maximize stylistic and rhythmic similarity to the described genre/mood while staying technically valid.',
          '- Since no explicit tab/chord reference is provided, anchor similarity to style + mood + key + tempo constraints.',
        ];
  }

  if (pct >= 85) {
    return [
      `- Similarity target is high (${pct}%): preserve the main progression feel and groove architecture with minor creative variation.`,
    ];
  }

  if (pct >= 60) {
    return [
      `- Similarity target is medium (${pct}%): keep recognizable style DNA but allow broader reharmonization and rhythmic variation.`,
    ];
  }

  return [
    `- Similarity target is low (${pct}%): use provided context only as inspiration and build a more original arrangement.`,
  ];
}

function getProgrammerCapabilityLines() {
  const playStyles = PLAY_STYLE_IDS
    .map(id => `${id} (${PLAY_STYLE_PRESETS[id].label})`)
    .join(', ');
  const fullInstrumentList = formatAllowedInstruments(256);

  return [
    'Programmer Capabilities (full):',
    '- Root required fields: version, song, tempo, volume, velocity, swing, mode, numSteps, steps.',
    '- Root optional fields: instruments, guitarType (legacy), playStyle, pickPattern, pickBeats, pickThenMode, singleString, humanizeTimeMs, humanizeVelPct, tightness, sections, mix, loop, arrangementNotes, capo, tuning.',
    '- Step fields: chord, modeOverride, strumOverride, vel, accent, humanizeVel, pushMs, swingOverride, singleStringOverride, pickPattern, pickBeats, pickThenMode, riff, riffBeats, hits.',
    '- hits[] format: { type: down|up|mute|arp, vel:0..100, swing:-1..1, spread:0..0.03, take:0..1 }.',
    '- riff format: { string:1..6, frets:[...], slide:boolean, hammer:boolean, riffVel:0..100, riffHumanize:0..1 }.',
    '- strumOverride map: 0=strum-down, 1=strum-up, 2=arpeggio, 3=mute.',
    `- Modes supported: ${AVAILABLE_MODES.join(', ')}.`,
    `- Play styles supported: ${playStyles}.`,
    '- Humanization controls: global humanizeTimeMs + humanizeVelPct + tightness, plus per-step accent/humanizeVel/pushMs/swingOverride.',
    '- Picking system: root/step pickPattern + pickBeats + pickThenMode.',
    '- Structure system: sections[] and optional loop region for arrangement flow.',
    `- Instruments catalog: ${fullInstrumentList}.`,
  ];
}

function buildAdvancedPrompt(songName, options = {}) {
  const safeSong = (songName || '').trim() || 'Untitled Groove';
  const style = (options.style || '').trim() || 'Acoustic Pop';
  const mood = (options.mood || '').trim() || 'Warm';
  const key = (options.key || '').trim() || 'C';
  const difficulty = options.difficulty || 'medium';
  const bars = clamp(Number.isFinite(options.bars) ? options.bars : 16, MIN_STEPS, MAX_STEPS);
  const bpmHint = Number.isFinite(options.bpmHint) ? clamp(Math.round(options.bpmHint), 40, 200) : null;
  const similarityPct = clamp(Number.isFinite(options.similarityPct) ? Math.round(options.similarityPct) : 100, 0, 100);
  const targetTempo = bpmHint ?? clamp(Math.round(tempo), 40, 200);
  const parsedTab = Array.isArray(options.parsedTabProgression) ? options.parsedTabProgression : [];
  const tabSnippet = typeof options.tabText === 'string' ? options.tabText.trim().slice(0, 1200) : '';

  const preferredInstruments = sanitizeInstrumentList(options.instruments, 'steel');
  const preferredPlayStyle = normalizePlayStyle(options.playStyle || playStyle, 'custom');
  const preferredPickPattern = normalizePickPatternText(options.pickPattern || pickPatternText || '');
  const preferredPickBeats = parsePickBeatsLoose(options.pickBeats, pickBeats);
  const preferredPickThenMode = normalizeMode(options.pickThenMode || pickThenMode || strumMode, 'strum-down');
  const smartLines = getSmartPromptInstructionLines(options);
  const similarityLines = getSimilarityInstructionLines(similarityPct, parsedTab.length > 0 || Boolean(tabSnippet));

  // Detect which parameters user explicitly set vs defaults
  const userSetBpm = Number.isFinite(options.bpmHint);
  const userSetInstruments = Array.isArray(options.instruments) && options.instruments.length > 0
    && !(options.instruments.length === 1 && options.instruments[0] === 'steel');
  const userSetMode = options.playStyle && options.playStyle !== 'custom';

  // Build concise but effective prompt
  const lines = [
    `Generate a JSON guitar arrangement for: "${safeSong}"`,
    `Style: ${style} | Mood: ${mood} | Key: ${key} | Difficulty: ${difficulty}`,
    `Steps: exactly ${bars} | Similarity: ${similarityPct}%`,
    '',
    '═══ YOU MUST CHOOSE THESE PARAMETERS TO MATCH THE STYLE ═══',
    userSetBpm
      ? `Tempo: use ${targetTempo} BPM (user specified).`
      : `Tempo: CHOOSE the best BPM for "${style}" style and "${mood}" mood (range 40-200). Do NOT just use ${targetTempo}.`,
    userSetInstruments
      ? `Instruments: use ${JSON.stringify(preferredInstruments)} (user specified).`
      : `Instruments: CHOOSE 1-3 best instruments from the catalog below for "${style}" style. Example: acoustic folk → ["steel"], rock → ["electric","bass"], jazz → ["jazz-0260-flu"].`,
    userSetMode
      ? `Play style / mode: use "${preferredPlayStyle}" as base (user specified).`
      : `Mode (бій/strum pattern): CHOOSE the best base mode for this style. Examples: ballad → arpeggio or fingerpick, pop → pattern-6, rock → pattern-8, punk → pattern-8-mute. Available: ${AVAILABLE_MODES.join(', ')}.`,
    `Chords: CHOOSE chords that fit the key "${key}", style "${style}" and mood "${mood}". Use interesting progressions, not just Am→C→G→Em.`,
    '',
    '',
    '═══ STRICT OUTPUT FORMAT ═══',
    'Return ONLY a single valid JSON object. NO markdown, NO code fences, NO comments, NO extra text.',
    '',
    '═══ ALLOWED VALUES ═══',
    `Chords: ${CHORD_NAMES.join(', ')}`,
    `Modes: ${AVAILABLE_MODES.join(', ')}`,
    `PlayStyles: ${PLAY_STYLE_IDS.join(', ')}`,
    `Instruments: ${formatAllowedInstruments(48)}`,
    '',
    '═══ SCHEMA ═══',
    'Root: { version:1, song:string, tempo:40-200, volume:0-100, velocity:10-100, swing:0-70,',
    '  mode:string, numSteps:number, steps:[], instruments:[], playStyle:string,',
    '  humanizeTimeMs:0-20, humanizeVelPct:0-20, tightness:0-1,',
    '  pickPattern:string, pickBeats:0-4, pickThenMode:string }',
    '',
    'Step: { chord:string (REQUIRED),',
    '  modeOverride:string|null, vel:0-100|null, accent:number|null,',
    '  strumOverride:null|0(down)|1(up)|2(arp)|3(mute),',
    '  swingOverride:0-70|null, singleStringOverride:1-6|null,',
    '  riff: { string:1-6, frets:[int,...] }|null, riffBeats:1-4|null,',
    '  hits: [{ type:"down"|"up"|"mute", vel:0-100 }]|null }',
    '',
  ];

  // ─── MUSICAL RULES (compact) ───
  lines.push('═══ RULES ═══');
  lines.push('1. numSteps MUST equal ' + bars + '. steps[] array MUST have exactly ' + bars + ' objects.');
  lines.push('2. Every step MUST have "chord" field. Use "—" for rests/pauses.');
  lines.push('3. chord values MUST be from the allowed list above. Do NOT invent chord names.');
  lines.push('4. Vary vel per step (range 72-96) to create dynamics. NOT every step same vel.');
  lines.push('5. Use 2-3 different modeOverride values across sections (verse vs chorus vs bridge).');
  lines.push('6. mode (root) sets the default. modeOverride on a step overrides it for that step only.');
  lines.push('7. Do NOT set modeOverride on every step — only where it differs from root mode.');
  lines.push('8. Pause steps (chord "—"): no strumOverride, no modeOverride, no vel.');
  lines.push('9. For realism: verse=softer (vel 75-82), chorus=louder (vel 85-95).');
  lines.push('10. riff.frets must be valid integers 0-12. riff.string must be 1-6.');

  if (smartLines.length) {
    lines.push('');
    lines.push('═══ STYLE-SPECIFIC ═══');
    smartLines.forEach(l => lines.push(l));
  }
  if (similarityLines.length) {
    similarityLines.forEach(l => lines.push(l));
  }

  // ─── REFERENCE ───
  if (parsedTab.length) {
    lines.push('');
    lines.push('═══ REFERENCE CHORDS ═══');
    lines.push(`Parsed: ${parsedTab.join(' | ')}`);
    lines.push(`Use these chords in order. If fewer than ${bars}, repeat cyclically.`);
  } else if (tabSnippet) {
    lines.push('');
    lines.push('═══ REFERENCE TAB ═══');
    lines.push(tabSnippet);
  }

  // ─── COMPLETE EXAMPLE (crucial for LLM compliance) ───
  lines.push('');
  lines.push('═══ CORRECT OUTPUT EXAMPLE (8 steps, adapt to your ' + bars + ' steps) ═══');

  const exampleMode = targetTempo >= 130 ? 'pattern-8' : (targetTempo <= 75 ? 'arpeggio' : 'pattern-6');
  const exInstr = JSON.stringify(preferredInstruments);
  lines.push('{');
  lines.push(`  "version": 1, "song": "${safeSong}", "tempo": ${targetTempo},`);
  lines.push(`  "volume": 80, "velocity": 82, "swing": ${clamp(Math.round(swingAmount), 0, 20)},`);
  lines.push(`  "humanizeTimeMs": 10, "humanizeVelPct": 8, "tightness": 0.85,`);
  lines.push(`  "instruments": ${exInstr}, "mode": "${exampleMode}",`);
  lines.push(`  "playStyle": "${preferredPlayStyle}",`);
  lines.push(`  "pickPattern": "${preferredPickPattern}", "pickBeats": ${preferredPickBeats}, "pickThenMode": "${preferredPickThenMode}",`);
  lines.push(`  "numSteps": 8,`);
  lines.push(`  "steps": [`);
  // Show diverse example steps with proper dynamic variation
  lines.push(`    { "chord": "Am", "vel": 84 },`);
  lines.push(`    { "chord": "Am", "vel": 80 },`);
  lines.push(`    { "chord": "F", "vel": 86 },`);
  lines.push(`    { "chord": "F", "vel": 82 },`);
  lines.push(`    { "chord": "C", "modeOverride": "${targetTempo >= 130 ? 'pattern-8-mute' : 'slow-strum'}", "vel": 90 },`);
  lines.push(`    { "chord": "C", "vel": 88 },`);
  lines.push(`    { "chord": "G", "vel": 92 },`);
  lines.push(`    { "chord": "G", "vel": 86 }`);
  lines.push(`  ]`);
  lines.push(`}`);
  lines.push('');
  lines.push('═══ COMMON MISTAKES TO AVOID ═══');
  lines.push('- DO NOT use chords not in the allowed list above');
  lines.push('- DO NOT put modeOverride on every step (only on section changes)');
  lines.push('- DO NOT make all vel the same value');
  lines.push('- DO NOT add markdown formatting or code fences');
  lines.push('- DO NOT use mode values not in the allowed list');
  lines.push('- DO NOT output ' + bars + ' steps with one repeating chord');
  lines.push('- DO NOT use strumOverride on pause steps (chord "—")');
  lines.push('- DO NOT just copy the example — create a UNIQUE arrangement for the requested song/style');
  lines.push('');
  lines.push(`NOW: generate exactly ${bars} steps for "${safeSong}" in ${style} style.`);
  if (!userSetBpm) lines.push('Pick the BEST tempo for this style — do NOT default to 90 BPM.');
  if (!userSetInstruments) lines.push('Pick the BEST instruments for this style from the catalog.');
  if (!userSetMode) lines.push('Pick the BEST strumming mode (бій) for this style.');
  lines.push('Output ONLY the JSON.');

  return lines.join('\n');
}

function buildSongPrompt(songName, options = {}) {
  return buildAdvancedPrompt(songName, options);
}

function applyScriptObject(script) {
  const parsedScript = validateScriptObject(script);

  document.getElementById('songNameInput').value = parsedScript.song;

  if (isPlaying) stopSequencer();

  numSteps = parsedScript.numSteps;
  setSongBarsSelectValue(parsedScript.numSteps);
  initSteps(parsedScript.numSteps);
  syncChordCountButtons();

  steps = parsedScript.steps.map(step => ({
    chord: step.chord,
    strumOverride: step.strumOverride,
    modeOverride: step.modeOverride,
    singleStringOverride: step.singleStringOverride,
    pickPattern: step.pickPattern || null,
    pickBeats: step.pickBeats ?? null,
    pickThenMode: step.pickThenMode || null,
    vel: Number.isFinite(step.vel) ? step.vel : null,
    accent: Number.isFinite(step.accent) ? step.accent : null,
    humanizeVel: Number.isFinite(step.humanizeVel) ? step.humanizeVel : null,
    pushMs: Number.isFinite(step.pushMs) ? step.pushMs : null,
    swingOverride: Number.isFinite(step.swingOverride) ? step.swingOverride : null,
    hits: Array.isArray(step.hits) ? step.hits.map(h => ({ type: h.type, vel: h.vel, swing: h.swing, spread: h.spread, take: h.take })) : null,
    riff: step.riff && typeof step.riff === 'object'
      ? {
          string: parseSingleStringLoose(step.riff.string) ?? 2,
          frets: Array.isArray(step.riff.frets) ? step.riff.frets.map(f => Math.max(0, Math.round(f))) : [],
          slide: Boolean(step.riff.slide),
          hammer: Boolean(step.riff.hammer),
          riffVel: Number.isFinite(step.riff.riffVel) ? step.riff.riffVel : null,
          riffHumanize: Number.isFinite(step.riff.riffHumanize) ? step.riff.riffHumanize : null,
        }
      : null,
    riffBeats: Number.isFinite(step.riffBeats) ? step.riffBeats : null,
  }));
  renderSteps();

  setStrumMode(parsedScript.mode);
  playStyle = normalizePlayStyle(parsedScript.playStyle, playStyle || 'custom');
  pickPatternText = normalizePickPatternText(parsedScript.pickPattern || '');
  pickBeats = parsePickBeatsLoose(parsedScript.pickBeats, 0);
  pickThenMode = normalizeMode(parsedScript.pickThenMode, 'strum-down');
  updatePlayStyleUI();
  updatePickingUI();
  singleString = parsedScript.singleString;
  updateSingleStringUI();

  tempo = parsedScript.tempo;
  updateTempoUI();

  volume = parsedScript.volume / 100;
  if (masterGain) masterGain.gain.value = volume;
  updateVolumeUI();

  velocity = parsedScript.velocity / 100;
  updateVelocityUI();

  swingAmount = parsedScript.swing;
  updateSwingUI();

  // Apply humanize / mix / structure
  humanizeTimeMs = parsedScript.humanizeTimeMs ?? humanizeTimeMs;
  humanizeVelPct = parsedScript.humanizeVelPct ?? humanizeVelPct;
  tightness = parsedScript.tightness ?? tightness;
  if (parsedScript.mix && typeof parsedScript.mix === 'object') {
    instrumentMix = parsedScript.mix;
  }
  if (Array.isArray(parsedScript.sections)) sections = parsedScript.sections.slice();
  loopRegion = parsedScript.loop || loopRegion;
  arrangementNotes = parsedScript.arrangementNotes || arrangementNotes;
  capo = parsedScript.capo ?? capo;
  if (Array.isArray(parsedScript.tuning)) tuning = parsedScript.tuning.slice();

  setActiveInstruments(parsedScript.instruments, { quiet: true });

  // ===================== TRACKS =====================
  // Parse tracks[] from JSON: each track has its own instruments, steps, volume, mute/solo
  if (Array.isArray(parsedScript.tracks) && parsedScript.tracks.length) {
    tracks = parsedScript.tracks.map(t => {
      const track = createTrack({
        name: t.name,
        instruments: t.instruments,
        volume: Number.isFinite(t.volume) ? (t.volume > 1 ? t.volume / 100 : t.volume) : 1,
        mute: t.mute,
        solo: t.solo,
      });
      // Per-track steps (optional; if absent, uses main steps)
      if (Array.isArray(t.steps) && t.steps.length) {
        track.steps = t.steps.map(s => {
          if (!s || typeof s !== 'object') return { chord: '—' };
          const c = normalizeChordToken(s.chord) || '—';
          return {
            chord: c,
            strumOverride: Number.isInteger(s.strumOverride) ? s.strumOverride : null,
            modeOverride: normalizeMode(s.modeOverride, null),
            singleStringOverride: parseSingleStringLoose(s.singleStringOverride) ?? null,
            vel: Number.isFinite(s.vel) ? clamp(Math.round(s.vel), 0, 100) : null,
            accent: Number.isFinite(s.accent) ? +s.accent : null,
            hits: Array.isArray(s.hits) ? s.hits.map(h => ({ type: h.type || 'down', vel: h.vel ?? null, swing: h.swing ?? null, spread: h.spread ?? null, take: h.take ?? null })) : null,
            riff: s.riff || null,
            riffBeats: s.riffBeats ?? null,
            pickPattern: s.pickPattern || null,
            pickBeats: s.pickBeats ?? null,
            pickThenMode: s.pickThenMode || null,
            humanizeVel: s.humanizeVel ?? null,
            pushMs: s.pushMs ?? null,
            swingOverride: s.swingOverride ?? null,
          };
        });
      }
      // Ensure track instruments are loaded
      track.instruments.forEach(type => {
        if (!loadedInstruments[type] && ctx && wafPlayer) loadInstrument(type);
      });
      return track;
    });
    renderTracksUI();
  } else {
    tracks = [];
  }

  currentStep = 0;
  updateChordDisplay(steps[0] ? steps[0].chord : CHORD_NAMES[CHORD_NAMES.length - 1]);
  flashStatus(`Скрипт завантажено: ${parsedScript.song}`, 1900);
}

function exportCurrentScript() {
  const songName = document.getElementById('songNameInput').value.trim() || 'Untitled Song';
  const payload = {
    version: SCRIPT_VERSION,
    song: songName,
    tempo,
    volume: Math.round(volume * 100),
    velocity: Math.round(velocity * 100),
    swing: swingAmount,
    guitarType,
    instruments: [...getActiveInstrumentList()],
    mode: strumMode,
    playStyle,
    pickPattern: pickPatternText,
    pickBeats,
    pickThenMode,
    numSteps: steps.length,
    steps: steps.map(step => {
      const item = { chord: step.chord };
      if (step.strumOverride !== null && PLAYABLE_CHORDS.includes(step.chord)) item.strumOverride = step.strumOverride;
      if (step.modeOverride) item.modeOverride = step.modeOverride;
      if (step.singleStringOverride !== null) item.singleStringOverride = step.singleStringOverride;
      if (step.pickPattern) item.pickPattern = step.pickPattern;
      if (Number.isFinite(step.pickBeats)) item.pickBeats = +step.pickBeats;
      if (step.pickThenMode) item.pickThenMode = step.pickThenMode;
      if (Number.isFinite(step.vel)) item.vel = Math.round(step.vel);
      if (Number.isFinite(step.accent)) item.accent = +step.accent;
      if (Number.isFinite(step.humanizeVel)) item.humanizeVel = +step.humanizeVel;
      if (Number.isFinite(step.pushMs)) item.pushMs = +step.pushMs;
      if (Number.isFinite(step.swingOverride)) item.swingOverride = +step.swingOverride;
      if (Array.isArray(step.hits)) item.hits = step.hits.map(h => ({ type: h.type, vel: h.vel, swing: h.swing, spread: h.spread, take: h.take }));
      if (step.riff) item.riff = Object.assign({}, step.riff);
      if (Number.isFinite(step.riffBeats)) item.riffBeats = step.riffBeats;
      return item;
    }),
  };
  // include global humanize/mix/structure if present
  if (humanizeTimeMs !== undefined) payload.humanizeTimeMs = humanizeTimeMs;
  if (humanizeVelPct !== undefined) payload.humanizeVelPct = humanizeVelPct;
  if (tightness !== undefined) payload.tightness = tightness;
  if (instrumentMix && Object.keys(instrumentMix).length) payload.mix = instrumentMix;
  if (Array.isArray(sections) && sections.length) payload.sections = sections.slice();
  if (loopRegion) payload.loop = loopRegion;
  if (arrangementNotes) payload.arrangementNotes = arrangementNotes;
  if (capo) payload.capo = capo;
  if (Array.isArray(tuning)) payload.tuning = tuning.slice();
  if (singleString !== null) payload.singleString = singleString;
  // Export tracks if defined
  if (tracks.length) {
    payload.tracks = tracks.map(t => {
      const td = { name: t.name, instruments: [...t.instruments], volume: Math.round(t.volume * 100) };
      if (t.mute) td.mute = true;
      if (t.solo) td.solo = true;
      if (Array.isArray(t.steps) && t.steps.length) {
        td.steps = t.steps.map(s => {
          const item = { chord: s.chord };
          if (s.modeOverride) item.modeOverride = s.modeOverride;
          if (Number.isFinite(s.vel)) item.vel = s.vel;
          if (Number.isFinite(s.accent)) item.accent = s.accent;
          if (s.strumOverride !== null) item.strumOverride = s.strumOverride;
          if (s.riff) item.riff = Object.assign({}, s.riff);
          if (s.riffBeats) item.riffBeats = s.riffBeats;
          if (s.pickPattern) item.pickPattern = s.pickPattern;
          if (s.pickBeats) item.pickBeats = s.pickBeats;
          if (s.pickThenMode) item.pickThenMode = s.pickThenMode;
          if (Array.isArray(s.hits)) item.hits = s.hits;
          return item;
        });
        td.numSteps = td.steps.length;
      }
      return td;
    });
  }
  document.getElementById('jsonScriptInput').value = JSON.stringify(payload, null, 2);
  flashStatus('JSON експортовано');
}

function buildScriptFromProgression(chords, songName = 'Tab Import') {
  const safeList = compressProgression(
    chords
      .map(ch => normalizeChordName(ch, '—'))
      .filter(Boolean),
    MAX_STEPS
  );

  if (safeList.length === 0) {
    throw new Error('Не вдалося сформувати акорди зі вставленої табулатури');
  }

  const stepsCount = clamp(safeList.length, MIN_STEPS, MAX_STEPS);
  return {
    version: SCRIPT_VERSION,
    song: songName || 'Tab Import',
    tempo,
    volume: Math.round(volume * 100),
    velocity: Math.round(velocity * 100),
    swing: swingAmount,
    guitarType,
    instruments: [...getActiveInstrumentList()],
    mode: strumMode,
    playStyle,
    pickPattern: pickPatternText,
    pickBeats,
    pickThenMode,
    numSteps: stepsCount,
    steps: Array.from({ length: stepsCount }, (_, i) => ({ chord: safeList[i % safeList.length] })),
    ...(singleString !== null ? { singleString } : {}),
  };
}

function importTabInputToProgram() {
  const rawTab = document.getElementById('tabInput').value.trim();
  if (!rawTab) {
    flashStatus('Встав табулатуру або акордовий текст', 2200);
    return;
  }

  const progression = parseTabOrChordProgression(rawTab);
  if (!progression.length) {
    flashStatus('Не вдалося розпізнати акорди з табулатури', 2400);
    return;
  }

  const songName = document.getElementById('songNameInput').value.trim() || 'Tab Import';
  const script = buildScriptFromProgression(progression, songName);
  document.getElementById('jsonScriptInput').value = JSON.stringify(script, null, 2);
  applyScriptObject(script);
  flashStatus(`Імпорт табулатури: ${progression.length} акордів`, 2200);
}

async function requestAiScript() {
  const apiKey = document.getElementById('aiApiKeyInput').value.trim();
  if (!apiKey) {
    flashStatus('Вкажи API key або встав JSON вручну', 2200);
    return;
  }

  const model = document.getElementById('aiModelInput').value.trim() || 'gpt-4o-mini';
  const settings = collectPromptSettings();
  const promptEl = document.getElementById('promptOutput');
  const prompt = promptEl.value.trim() || buildSongPrompt(settings.songName, settings);
  promptEl.value = prompt;

  const askBtn = document.getElementById('askAiBtn');
  const prevText = askBtn.textContent;
  askBtn.textContent = 'AI...';
  askBtn.disabled = true;

  try {
    const response = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.55,
        top_p: 0.92,
        messages: [
          {
            role: 'system',
            content: [
              'You are a JSON generator for a guitar sequencer app.',
              'Output: exactly one valid JSON object, nothing else.',
              'No markdown, no ``` fences, no comments, no explanations before or after the JSON.',
              'The JSON must parse with JSON.parse() directly.',
              '',
              'CRITICAL RULES:',
              `1. Allowed chords ONLY: ${CHORD_NAMES.join(', ')}. Do NOT invent chord names.`,
              `2. Allowed modes ONLY: ${AVAILABLE_MODES.join(', ')}. Do NOT invent mode names.`,
              '3. "numSteps" must equal the length of "steps" array. Count carefully.',
              '4. Per-step dynamics: vary "vel" between 72-96. NOT all the same.',
              '5. Set "modeOverride" only on section transitions (e.g., verse→chorus), NOT on every step.',
              '6. Pause steps (chord "—"): no other fields needed.',
              '7. "riff.frets" must contain integers 0-12. "riff.string" must be 1-6.',
              '8. Do NOT use field names that don\'t exist in the schema.',
            ].join('\n'),
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText.slice(0, 180)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI не повернув текст');

    const scriptObj = extractJsonObjectFromText(content);
    document.getElementById('jsonScriptInput').value = JSON.stringify(scriptObj, null, 2);
    try {
      applyScriptObject(scriptObj);
    } catch (errApply) {
      const fixed = autoFixScriptObject(scriptObj);
      applyScriptObject(fixed);
      document.getElementById('jsonScriptInput').value = JSON.stringify(fixed, null, 2);
      flashStatus('AI JSON автоматично виправлено і застосовано', 2200);
    }
  } catch (err) {
    flashStatus(`Помилка AI: ${err.message}`, 2600);
  } finally {
    askBtn.textContent = prevText;
    askBtn.disabled = false;
  }
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const temp = document.createElement('textarea');
  temp.value = text;
  temp.style.position = 'fixed';
  temp.style.left = '-9999px';
  document.body.appendChild(temp);
  temp.focus();
  temp.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(temp);
  return ok;
}

// ===================== TRACKS UI =====================
function addTrack(opts = {}) {
  const track = createTrack(opts);
  tracks.push(track);
  // Load instruments for the new track
  if (ctx && wafPlayer) {
    track.instruments.forEach(type => { if (!loadedInstruments[type]) loadInstrument(type); });
  }
  renderTracksUI();
  return track;
}

function removeTrack(index) {
  if (index < 0 || index >= tracks.length) return;
  const t = tracks[index];
  // Stop its voices
  const voices = t.activeVoices.splice(0, t.activeVoices.length);
  voices.forEach(v => stopTrackedVoice(v, 0.01));
  tracks.splice(index, 1);
  if (activeTrackIndex >= tracks.length) activeTrackIndex = Math.max(0, tracks.length - 1);
  renderTracksUI();
}

function toggleTrackMute(index) {
  if (!tracks[index]) return;
  tracks[index].mute = !tracks[index].mute;
  renderTracksUI();
}

function toggleTrackSolo(index) {
  if (!tracks[index]) return;
  tracks[index].solo = !tracks[index].solo;
  renderTracksUI();
}

function setTrackVolume(index, vol) {
  if (!tracks[index]) return;
  tracks[index].volume = clamp(vol, 0, 1);
}

function renderTracksUI() {
  let container = document.getElementById('tracksPanel');
  if (!container) {
    // Create the tracks panel element dynamically
    const anchor = document.getElementById('stepsContainer')?.parentElement;
    if (!anchor) return;
    container = document.createElement('div');
    container.id = 'tracksPanel';
    container.className = 'tracks-panel';
    anchor.insertBefore(container, document.getElementById('stepsContainer'));
  }

  if (!tracks.length) {
    container.innerHTML = '<div class="tracks-empty">Один трек (класичний режим) · <button id="addTrackBtn" class="track-add-btn">+ Додати трек</button></div>';
    const addBtn = container.querySelector('#addTrackBtn');
    if (addBtn) addBtn.addEventListener('click', () => {
      // Auto-create 2 tracks from current state: guitar + bass
      const currentInsts = getActiveInstrumentList();
      const bassInsts = currentInsts.filter(t => (INSTRUMENT_LIBRARY[t] || {}).bassOnly);
      const guitarInsts = currentInsts.filter(t => !(INSTRUMENT_LIBRARY[t] || {}).bassOnly);
      addTrack({ name: '🎸 Гітара', instruments: guitarInsts.length ? guitarInsts : ['steel'] });
      if (bassInsts.length) {
        addTrack({ name: '🎸 Бас', instruments: bassInsts });
      } else {
        addTrack({ name: '🎸 Бас', instruments: ['bf-0340-flu'] });
      }
    });
    return;
  }

  let html = '<div class="tracks-header">🎚️ Доріжки <button id="addNewTrackBtn" class="track-add-btn" title="Додати трек">+</button></div>';
  tracks.forEach((track, idx) => {
    const muteClass = track.mute ? 'active' : '';
    const soloClass = track.solo ? 'active' : '';
    const volPct = Math.round(track.volume * 100);
    const instNames = track.instruments.map(t => {
      const cfg = INSTRUMENT_LIBRARY[t];
      return cfg ? (cfg.shortLabel || cfg.label) : t;
    }).join(', ');
    html += `
      <div class="track-row ${idx === activeTrackIndex ? 'track-selected' : ''}" data-track="${idx}">
        <div class="track-name" data-track="${idx}" title="${instNames}">${track.name}</div>
        <div class="track-controls">
          <button class="track-mute-btn ${muteClass}" data-track="${idx}" title="Mute">M</button>
          <button class="track-solo-btn ${soloClass}" data-track="${idx}" title="Solo">S</button>
          <input type="range" class="track-vol" data-track="${idx}" min="0" max="100" value="${volPct}" title="Гучність ${volPct}%">
          <button class="track-del-btn" data-track="${idx}" title="Видалити">✕</button>
        </div>
        <div class="track-instruments">${instNames}</div>
      </div>`;
  });
  container.innerHTML = html;

  // Event listeners
  container.querySelector('#addNewTrackBtn')?.addEventListener('click', () => {
    addTrack({ name: `Track ${tracks.length + 1}`, instruments: ['steel'] });
  });
  container.querySelectorAll('.track-mute-btn').forEach(btn =>
    btn.addEventListener('click', () => toggleTrackMute(parseInt(btn.dataset.track)))
  );
  container.querySelectorAll('.track-solo-btn').forEach(btn =>
    btn.addEventListener('click', () => toggleTrackSolo(parseInt(btn.dataset.track)))
  );
  container.querySelectorAll('.track-vol').forEach(slider =>
    slider.addEventListener('input', e => setTrackVolume(parseInt(e.target.dataset.track), parseInt(e.target.value) / 100))
  );
  container.querySelectorAll('.track-del-btn').forEach(btn =>
    btn.addEventListener('click', () => removeTrack(parseInt(btn.dataset.track)))
  );
  container.querySelectorAll('.track-name').forEach(el =>
    el.addEventListener('click', () => {
      activeTrackIndex = parseInt(el.dataset.track);
      renderTracksUI();
    })
  );
}

// ===================== RENDER STEPS =====================
function renderSteps() {
  const container = document.getElementById('stepsContainer');
  container.innerHTML = '';
  steps.forEach((step, i) => {
    const cell = document.createElement('div');
    cell.className = 'step-cell' + (!PLAYABLE_CHORDS.includes(step.chord) ? ' empty-chord' : '');
    cell.id = `step-${i}`;
    const badges = [];
    if (step.singleStringOverride !== null) badges.push(`1-STR ${step.singleStringOverride}`);
    if (step.pickPattern) {
      const shortPick = step.pickPattern.length > 12 ? `${step.pickPattern.slice(0, 12)}...` : step.pickPattern;
      badges.push(`PICK ${shortPick}`);
    }
    cell.innerHTML = `
      <div class="step-num">Step ${i+1}</div>
      <select class="chord-selector" data-i="${i}">
        ${CHORD_NAMES.map(c => `<option value="${c}" ${c===step.chord?'selected':''}>${c}</option>`).join('')}
      </select>
      <div class="strum-type-row">
        ${['↓','↑','♩','✋'].map((s,si) => `<div class="strum-dot ${step.strumOverride === si ? 'sel':''}" data-i="${i}" data-si="${si}" title="${['Бій↓','Бій↑','Перебір','Mute'][si]}">${s}</div>`).join('')}
      </div>
      <div class="step-note">${badges.join(' | ')}</div>
      <div class="fret-viz"><canvas class="mini-fret" data-i="${i}" width="96" height="30"></canvas></div>
    `;
    container.appendChild(cell);

    // Draw mini fret
    setTimeout(() => drawMiniFret(i, step.chord), 0);
  });

  // Events
  container.querySelectorAll('.chord-selector').forEach(sel => {
    sel.addEventListener('change', e => {
      const i = parseInt(e.target.dataset.i);
      steps[i].chord = e.target.value;
      if (!PLAYABLE_CHORDS.includes(steps[i].chord)) {
        steps[i].strumOverride = null;
        steps[i].pickPattern = null;
        steps[i].pickBeats = null;
        steps[i].pickThenMode = null;
      }
      document.getElementById(`step-${i}`).classList.toggle('empty-chord', !PLAYABLE_CHORDS.includes(e.target.value));
      drawMiniFret(i, e.target.value);
      if (i === currentStep && !isPlaying) updateChordDisplay(e.target.value);
    });
  });

  container.querySelectorAll('.strum-dot').forEach(dot => {
    dot.addEventListener('click', e => {
      const i = parseInt(e.target.dataset.i);
      if (!PLAYABLE_CHORDS.includes(steps[i].chord)) {
        flashStatus('Для паузи strumOverride недоступний', 1500);
        return;
      }
      const si = parseInt(e.target.dataset.si);
      steps[i].strumOverride = steps[i].strumOverride === si ? null : si;
      steps[i].modeOverride = null;
      renderSteps();
    });
  });
}

function drawMiniFret(i, chordName) {
  const canvas = document.querySelector(`.mini-fret[data-i="${i}"]`);
  if (!canvas) return;
  const ctx2d = canvas.getContext('2d');
  canvas.width = 96; canvas.height = 30;
  ctx2d.clearRect(0,0,96,30);

  const chord = CHORDS[chordName];
  if (!chord || chord.notes.length === 0) {
    ctx2d.fillStyle = 'rgba(200,114,10,0.15)';
    ctx2d.fillRect(30,12,36,6);
    ctx2d.fillStyle = 'rgba(200,114,10,0.3)';
    ctx2d.font = '8px Courier Prime';
    ctx2d.textAlign = 'center';
    ctx2d.fillText('—',48,18);
    return;
  }

  // Draw 6 strings
  for (let s=0;s<6;s++) {
    const x = 10 + s * 14;
    ctx2d.strokeStyle = 'rgba(212,184,150,0.3)';
    ctx2d.lineWidth = s < 2 ? 0.8 : s < 4 ? 1.2 : 1.6;
    ctx2d.beginPath();
    ctx2d.moveTo(x, 2);
    ctx2d.lineTo(x, 28);
    ctx2d.stroke();
  }

  // Draw 3 frets
  for (let f=0;f<=3;f++) {
    const y = 4 + f * 8;
    ctx2d.strokeStyle = f===0 ? 'rgba(212,184,150,0.8)' : 'rgba(138,112,96,0.3)';
    ctx2d.lineWidth = f===0 ? 2 : 1;
    ctx2d.beginPath();
    ctx2d.moveTo(10,y);
    ctx2d.lineTo(80,y);
    ctx2d.stroke();
  }

  // Dots
  chord.notes.forEach(n => {
    if (n.f === 0) return;
    const x = 10 + (5-n.s) * 14;
    const y = 4 + (n.f - 0.5) * 8;
    ctx2d.beginPath();
    ctx2d.arc(x, y, 3.5, 0, Math.PI*2);
    ctx2d.fillStyle = '#f0920e';
    ctx2d.shadowColor = 'rgba(240,146,14,0.6)';
    ctx2d.shadowBlur = 4;
    ctx2d.fill();
    ctx2d.shadowBlur = 0;
  });
}

// ===================== CHORD DIAGRAM =====================
function drawChordDiagram(chordName) {
  const chord = CHORDS[chordName];
  const svgStrings = document.getElementById('svgStrings');
  const svgFrets = document.getElementById('svgFrets');
  const svgDots = document.getElementById('svgDots');
  const svgName = document.getElementById('svgChordName');

  svgStrings.innerHTML = '';
  svgFrets.innerHTML = '';
  svgDots.innerHTML = '';
  svgName.textContent = chordName;

  const sx = 15, ex = 95, sy = 15, ey = 95;
  const numStrings = 6;
  const numFrets = 4;

  for (let s=0;s<numStrings;s++) {
    const x = sx + s * (ex-sx)/(numStrings-1);
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1', x); line.setAttribute('y1', sy);
    line.setAttribute('x2', x); line.setAttribute('y2', ey);
    line.setAttribute('stroke', s < 2 ? 'rgba(212,184,150,0.5)' : 'rgba(212,184,150,0.7)');
    line.setAttribute('stroke-width', s < 2 ? '0.8' : s < 4 ? '1.2' : '1.8');
    svgStrings.appendChild(line);
  }

  for (let f=0;f<=numFrets;f++) {
    const y = sy + f * (ey-sy)/numFrets;
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1', sx); line.setAttribute('y1', y);
    line.setAttribute('x2', ex); line.setAttribute('y2', y);
    line.setAttribute('stroke', f===0 ? 'rgba(212,184,150,0.9)' : 'rgba(138,112,96,0.4)');
    line.setAttribute('stroke-width', f===0 ? '3' : '1');
    svgFrets.appendChild(line);
  }

  if (chord && chord.notes.length > 0) {
    chord.notes.forEach(n => {
      if (n.f === 0) {
        const x = sx + (5-n.s) * (ex-sx)/(numStrings-1);
        const circ = document.createElementNS('http://www.w3.org/2000/svg','circle');
        circ.setAttribute('cx', x); circ.setAttribute('cy', sy - 5);
        circ.setAttribute('r', 3);
        circ.setAttribute('fill', 'none');
        circ.setAttribute('stroke', 'rgba(200,114,10,0.5)');
        circ.setAttribute('stroke-width', '1');
        svgDots.appendChild(circ);
      } else {
        const x = sx + (5-n.s) * (ex-sx)/(numStrings-1);
        const y = sy + (n.f - 0.5) * (ey-sy)/numFrets;
        const circ = document.createElementNS('http://www.w3.org/2000/svg','circle');
        circ.setAttribute('cx', x); circ.setAttribute('cy', y);
        circ.setAttribute('r', 6);
        circ.setAttribute('fill', '#f0920e');
        circ.setAttribute('filter', 'url(#glow)');
        svgDots.appendChild(circ);
      }
    });

    // SVG filter for glow
    const defs = document.getElementById('svgDefs') || (() => {
      const d = document.createElementNS('http://www.w3.org/2000/svg','defs');
      d.id = 'svgDefs';
      d.innerHTML = `<filter id="glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
      document.getElementById('chordDiagram').prepend(d);
      return d;
    })();
  }
}

// ===================== STRINGS DISPLAY =====================
function buildStringsDisplay() {
  const el = document.getElementById('stringsDisplay');
  el.innerHTML = '<div class="panel-title" style="margin-bottom:8px;">🎶 Струни</div>';
  STRING_NAMES.forEach((name,i) => {
    const row = document.createElement('div');
    row.className = 'string-row';
    row.innerHTML = `<span class="string-name">${name}</span><div class="string-line" id="string-${i}"></div>`;
    el.appendChild(row);
  });
}

function vibrateStrings(chord, mode, delay = 0, singleStringChoice = null) {
  const chordData = CHORDS[chord];
  if (!chordData) return;
  const selectedString = parseSingleStringLoose(singleStringChoice);
  const selectedIndex = selectedString === null ? null : selectedString - 1;
  const filterOrder = order => selectedIndex === null ? order : order.filter(si => si === selectedIndex);

  const isArp = mode === 'arpeggio' || mode === 'arpeggio-rev' || mode === 'fingerpick';
  const isMute = mode === 'mute';
  const patternHits = {
    'pattern-4': 4,
    'pattern-4-mute': 4,
    'pattern-6': 6,
    'pattern-6-mute': 6,
    'pattern-8': 8,
    'pattern-8-mute': 8,
  };
  const patternCount = patternHits[mode] || 0;
  const numStr = 6;

  if (isMute) {
    const muteOrder = filterOrder(Array.from({ length: numStr }, (_, i) => i));
    for (let i = 0; i < muteOrder.length; i++) {
      const si = muteOrder[i];
      setTimeout(() => {
        const el = document.getElementById(`string-${si}`);
        if (el) { el.classList.add('vibrate'); setTimeout(()=>el.classList.remove('vibrate'),150); }
      }, delay + i * 20);
    }
    return;
  }

  if (patternCount) {
    const beatMs = 60000 / Math.max(tempo, 1);
    const stepMs = beatMs / patternCount;

    for (let hit = 0; hit < patternCount; hit++) {
      const withMute = mode.includes('mute') && hit % 2 === 1;
      const down = hit % 2 === 0;
      const baseOrder = down ? [5,4,3,2,1,0] : [0,1,2,3,4,5];
      const order = filterOrder(withMute ? [0,1,2,3,4,5] : baseOrder);

      order.forEach((si, pos) => {
        const d = delay + hit * stepMs + pos * (withMute ? 3 : 8);
        setTimeout(() => {
          const el = document.getElementById(`string-${si}`);
          if (!el) return;
          el.classList.add('vibrate');
          setTimeout(() => el.classList.remove('vibrate'), withMute ? 110 : 250);
        }, d);
      });
    }
    return;
  }

  const order = filterOrder(mode === 'arpeggio-rev' ? [0,1,2,3,4,5].reverse() : [0,1,2,3,4,5]);
  const stagger = isArp ? 80 : (mode === 'slow-strum' ? 50 : 20);

  order.forEach((si, pos) => {
    const d = delay + pos * stagger;
    setTimeout(() => {
      const el = document.getElementById(`string-${si}`);
      if (el) { el.classList.add('vibrate'); setTimeout(()=>el.classList.remove('vibrate'),300); }
    }, d);
  });
}

// ===================== PLAY CHORD =====================
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function getPlaybackInstrumentLayers(articulation = {}, trackInstruments = null) {
  const selected = trackInstruments || getActiveInstrumentList();
  const stringIndex = Number.isInteger(articulation.stringIndex)
    ? articulation.stringIndex
    : null;

  return selected.filter(type => {
    const cfg = INSTRUMENT_LIBRARY[type];
    if (!cfg) return false;
    if (!cfg.bassOnly) return true;
    if (stringIndex === null) return true;
    return stringIndex >= 4;
  });
}

function playNote(pitch, time, duration, gainVal, articulation = {}, trackCtx = null) {
  if (!ctx) return;
  const {
    stringIndex = 0,
    direction = 'down',
    muted = false,
    accent = 1,
    maxDuration = null,
    stepMeta = null,
    releaseBias = 1,
    chordRoot = null,
  } = articulation;

  const stringCurve = [1.0, 0.95, 0.9, 0.86, 0.82, 0.78];
  const idx = clamp(Math.round(stringIndex), 0, 5);
  const dirFactor = direction === 'up' ? (0.94 + (idx * 0.02)) : (1.02 - (idx * 0.015));
  const stringFactor = stringCurve[idx] || 0.85;
  const velHuman = getVelocityHumanizeMultiplier(stepMeta, muted ? 0.35 : 1);
  const safeGain = Math.max(0, Math.min(1, gainVal * stringFactor * dirFactor * accent * velHuman));
  const playedPitch = clamp(pitch, 0, 127);
  const cappedDuration = (maxDuration && maxDuration > 0)
    ? Math.min(duration, maxDuration)
    : duration;
  const sustainBase = muted ? 0.34 : (0.88 + Math.random() * 0.24);
  const sustainHuman = muted ? 1 : getVelocityHumanizeMultiplier(stepMeta, 0.25);
  const safeReleaseBias = Math.max(0.55, Number.isFinite(releaseBias) ? releaseBias : 1);
  const playedDuration = Math.max(0.045, cappedDuration * sustainBase * sustainHuman * safeReleaseBias);
  const layers = getPlaybackInstrumentLayers({ ...articulation, stringIndex: idx },
    trackCtx ? trackCtx.instruments : null);
  if (!layers.length) return;

  const trackVolume = trackCtx ? trackCtx.volume : 1;
  const mixNormalize = 1 / Math.sqrt(layers.length);
  layers.forEach((type, layerIndex) => {
    const cfg = INSTRUMENT_LIBRARY[type] || INSTRUMENT_LIBRARY.steel;
    // Bass instruments: route to bass bus & play root note only
    const isBass = Boolean(cfg.bassOnly);
    let layerPitch = clamp(playedPitch + (cfg.pitchShift || 0), 0, 127);
    if (isBass && Number.isFinite(chordRoot)) {
      layerPitch = clamp(chordRoot + (cfg.pitchShift || 0), 0, 127);
    }
    const layerDuration = Math.max(0.045, playedDuration * (cfg.durationMul || 1));
    const layerTime = Math.max(0, time + (layerIndex * 0.0018));
    const layerWhen = ctx.currentTime + layerTime;
    const layerGain = Math.max(
      0,
      Math.min(1, safeGain * (cfg.mixGain || 1) * mixNormalize * (1 - layerIndex * 0.03) * trackVolume
    ));
    const layerInstrument = loadedInstruments[type] || null;
    // Route bass instruments to dedicated bass bus
    const outputNode = isBass && bassLowPass ? bassLowPass : (dryGain || masterGain);

    if (layerInstrument && wafPlayer) {
      try {
        const envelope = wafPlayer.queueWaveTable(
          ctx,
          outputNode,
          layerInstrument,
          layerWhen,
          layerPitch,
          layerDuration,
          layerGain
        );
        if (envelope) {
          const voiceObj = {
            expiresAt: layerWhen + layerDuration + 0.1,
            stop(releaseSecs = 0.02) {
              if (!ctx) return;
              const stopAt = ctx.currentTime + Math.max(0.001, releaseSecs);
              try {
                if (typeof envelope.cancel === 'function') envelope.cancel(stopAt);
              } catch (err) {
                // ignore envelope cancel errors
              }
              try {
                const src = envelope.audioBufferSourceNode || envelope.source;
                if (src && typeof src.stop === 'function') src.stop(stopAt);
              } catch (err) {
                // ignore source stop errors
              }
            }
          };
          if (trackCtx) {
            registerTrackVoice(trackCtx._track, voiceObj);
          } else {
            registerActiveVoice(voiceObj);
          }
        }
        if (wafReverb && !muted) {
          wafPlayer.queueWaveTable(
            ctx,
            wafReverb.input,
            layerInstrument,
            layerWhen + 0.004,
            layerPitch,
            layerDuration * 0.68,
            layerGain * 0.11
          );
        }
        return;
      } catch (err) {
        // Fallback below
      }
    }

    const fallbackVoice = playNoteFallback(midiToFreq(layerPitch), layerTime, layerDuration, layerGain);
    if (trackCtx) {
      registerTrackVoice(trackCtx._track, fallbackVoice);
    } else {
      registerActiveVoice(fallbackVoice);
    }
  });
}

function strumStroke(notes, {
  time = 0,
  direction = 'down',
  duration = 0.35,
  gain = 0.8,
  spread = null,
  ratio = 1,
  maxDuration = null,
  mode = 'strum-down',
  stepMeta = null,
  chordRoot = null,
  trackCtx = null,
} = {}) {
  if (!Array.isArray(notes) || notes.length === 0) return;
  const order = direction === 'up' ? [...notes].reverse() : [...notes];
  const takeCount = Math.max(1, Math.round(order.length * Math.max(0.2, Math.min(1, ratio))));
  const subset = order.slice(0, takeCount);
  const spreadSecs = (Number.isFinite(spread) && spread > 0)
    ? spread
    : getStrumSpreadSeconds(mode, direction, stepMeta);
  const maxStringJitterMs = Math.min(8, spreadSecs * 1000 * 0.45);

  subset.forEach((note, i) => {
    const timingJitter = getTimingHumanizeMs(stepMeta, maxStringJitterMs) / 1000;
    const stringAccent = direction === 'down'
      ? Math.max(0.78, 1.03 - (i * 0.035))
      : Math.max(0.8, 0.92 + (i * 0.028));
    const noteTime = Math.max(0, time + (i * spreadSecs) + timingJitter);
    playNote(
      note.pitch,
      noteTime,
      duration,
      gain * stringAccent,
      {
        stringIndex: note.stringIndex,
        direction,
        muted: false,
        maxDuration,
        stepMeta,
        releaseBias: mode === 'slow-strum' ? 1.1 : 1,
        chordRoot,
      },
      trackCtx
    );
  });
}

function mutedStroke(notes, time = 0, gain = 0.28, trackCtx = null) {
  if (!ctx) return;
  if (!Array.isArray(notes) || notes.length === 0) return;
  // Choose a center pitch for a faint tone (middle of the voicing)
  const midNote = notes[Math.floor(notes.length / 2)];
  const midPitch = (midNote && Number.isFinite(midNote.pitch)) ? midNote.pitch : 48;

  notes.forEach((note, i) => {
    const t = Math.max(0, time + i * 0.006);
    // Short percussive noise burst
    try {
      const now = ctx.currentTime + t;
      const noise = ctx.createBufferSource();
      const noiseGain = ctx.createGain();
      const noiseFilter = ctx.createBiquadFilter();

      // tiny noise buffer
      const len = Math.max(4, Math.floor(ctx.sampleRate * 0.01));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let j = 0; j < len; j++) data[j] = (Math.random() * 2 - 1) * 0.6;
      noise.buffer = buf;

      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 2400 + Math.random() * 1200;
      noiseFilter.Q.value = 0.9;

      noiseGain.gain.setValueAtTime(0, now);
      noiseGain.gain.linearRampToValueAtTime(gain * 0.85, now + 0.002);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

      noise.connect(noiseFilter);
      noiseFilter.connect(dryGain || masterGain);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(dryGain || masterGain);

      noise.start(now);
      noise.stop(now + 0.06 + Math.random() * 0.02);
    } catch (err) {
      // ignore if audio nodes fail
    }

    // Add a very short, low-gain pitched click to give slight pitch hint
    playNote(
      midPitch,
      t,
      0.045,
      Math.max(0.06, gain * 0.28) * (0.85 + Math.random() * 0.2),
      { stringIndex: note.stringIndex, direction: 'down', muted: true, accent: 0.8 },
      trackCtx
    );
  });
}

function playPatternMode(notes, beatDuration, hits, withMute = false, baseVel = velocity, stepMeta = null, chordRoot = null, trackCtx = null) {
  if (!Array.isArray(notes) || notes.length === 0 || hits < 2) return;
  const stepDur = beatDuration / hits;
  const baseDur = Math.max(stepDur * 1.12, 0.08);
  // Cap each note so it can't bleed into the next sub-step
  const maxNoteDur = stepDur * 0.96;

  const humanMs = getEffectiveHumanizeTimeMs(stepMeta);
  const tight = getEffectiveTightness(stepMeta);
  const patternModeKey = `pattern-${hits}${withMute ? '-mute' : ''}`;

  // Authentic accent and ratio maps for playPatternMode (direct playChord calls)
  const accentMaps = {
    4:  [1.0,  0.62, 0.38, 0.58],
    6:  [1.0,  0.52, 0.48, 0.94, 0.72, 0.48],
    8:  [1.0,  0.48, 0.44, 0.92, 0.72, 0.44, 0.68, 0.46],
    12: [1.0, 0.48, 0.42, 0.90, 0.48, 0.42, 0.80, 0.48, 0.42, 0.90, 0.48, 0.42]
  };
  const ratioMaps = {
    4:  [1.0,  0.55, 0.72, 0.52],
    6:  [1.0,  0.62, 0.50, 0.78, 0.82, 0.48],
    8:  [1.0,  0.58, 0.48, 0.75, 0.82, 0.46, 0.70, 0.48],
    12: [1.0, 0.55, 0.46, 0.78, 0.55, 0.46, 0.82, 0.55, 0.46, 0.78, 0.55, 0.46]
  };

  for (let i = 0; i < hits; i++) {
    const baseT = i * stepDur;
    const jitter = getTimingHumanizeMs(stepMeta, humanMs * (0.25 + (1 - tight))) / 1000;
    let t = baseT + jitter;
    const down = i % 2 === 0;
    const isGhost = withMute && i % 2 === 1;

    const map = accentMaps[hits] || null;
    const accentVal = map ? map[i % map.length] : 1.0;
    // slight micro-delay for upstrokes to feel human (5-12ms), scaled by looseness
    const microDelay = (!down) ? (0.005 + Math.random() * 0.007) * (1 - tight) : 0;
    const actualT = t + microDelay;

    if (isGhost) {
      mutedStroke(notes, actualT, baseVel * 0.34 * accentVal, trackCtx);
      continue;
    }

    const ratioMap = ratioMaps[hits] || null;
    const ratio = ratioMap ? ratioMap[i % ratioMap.length] : (down ? 1 : 0.72);

    const gain = baseVel * (0.72 + (down ? 0.16 : 0.08)) * accentVal;
    strumStroke(notes, {
      time: actualT,
      direction: down ? 'down' : 'up',
      duration: baseDur,
      gain,
      spread: null,
      ratio,
      maxDuration: maxNoteDur,
      mode: patternModeKey,
      stepMeta,
      chordRoot,
      trackCtx,
    });
  }
}

function getChordPlayableNotes(chordName, singleStringChoice = null) {
  const chord = CHORDS[chordName];
  if (!chord) return [];

  let notePool = [];

  if (Array.isArray(chord.notes) && chord.notes.length) {
    const byString = Array(6).fill(null);
    chord.notes.forEach(note => {
      if (!note || typeof note !== 'object') return;
      if (!Number.isFinite(note.s) || !Number.isFinite(note.f)) return;
      const stringIndexHighToLow = Math.max(0, Math.min(5, Math.round(note.s)));
      const lowToHighIndex = 5 - stringIndexHighToLow;
      const fret = Math.max(0, Math.round(note.f));
      byString[lowToHighIndex] = OPEN_STRING_MIDI_LOW_TO_HIGH[lowToHighIndex] + fret;
    });
    notePool = byString
      .map((pitch, lowToHighIndex) => ({
        pitch,
        stringIndex: 5 - lowToHighIndex,
      }))
      .filter(note => Number.isFinite(note.pitch) && note.pitch >= 0);
  } else {
    const rawPitches = Array.isArray(chord.midi) && chord.midi.length > 0
      ? chord.midi.slice(0, 6)
      : (Array.isArray(chord.freqs) ? chord.freqs.map(freq =>
          (typeof freq === 'number' && freq > 0) ? Math.round(69 + 12 * Math.log2(freq / 440)) : -1
        ) : []);

    while (rawPitches.length < 6) rawPitches.unshift(-1);
    notePool = rawPitches
      .map((pitch, lowToHighIndex) => ({
        pitch,
        stringIndex: 5 - lowToHighIndex,
      }))
      .filter(note => Number.isFinite(note.pitch) && note.pitch >= 0);
  }

  notePool.sort((a, b) => b.stringIndex - a.stringIndex);

  const singleStringValue = parseSingleStringLoose(singleStringChoice);
  const selectedStringIndex = singleStringValue === null ? null : singleStringValue - 1;
  return selectedStringIndex === null
    ? notePool
    : notePool.filter(note => note.stringIndex === selectedStringIndex);
}

function resolvePickedNote(notes, stringNumber) {
  if (!Array.isArray(notes) || !notes.length) return null;
  const safeNum = clamp(Math.round(stringNumber), 1, 6);
  const targetIndex = safeNum - 1;
  const exact = notes.find(note => note.stringIndex === targetIndex);
  if (exact) return exact;

  let nearest = notes[0];
  let nearestDist = Math.abs(nearest.stringIndex - targetIndex);
  for (let i = 1; i < notes.length; i++) {
    const dist = Math.abs(notes[i].stringIndex - targetIndex);
    if (dist < nearestDist) {
      nearest = notes[i];
      nearestDist = dist;
    }
  }
  return nearest;
}

// ===================== VOICE LEADING =====================
// Minimize pitch jumps between consecutive chords by matching notes on the SAME string.
// Previous implementation matched by array index, which broke when consecutive chords
// had different numbers of notes (e.g. D(4 notes) → E(6 notes) shifted everything up an octave).
function applyVoiceLeading(notes, chordName, externalPrevPitches) {
  if (!notes.length) return notes;
  const prevPitches = externalPrevPitches !== undefined ? externalPrevPitches : previousVoicingPitches;
  if (!prevPitches || typeof prevPitches !== 'object') {
    // Store as a map: stringIndex → pitch
    const newMap = {};
    notes.forEach(n => { newMap[n.stringIndex] = n.pitch; });
    if (externalPrevPitches === undefined) previousVoicingPitches = newMap;
    return notes;
  }

  const result = notes.map(note => {
    // Match by string, not by array position
    const prevPitch = prevPitches[note.stringIndex];
    if (!Number.isFinite(prevPitch)) return note;

    const pitchClass = note.pitch % 12;
    let bestPitch = note.pitch;
    let bestDist = Math.abs(note.pitch - prevPitch);

    // Try closest octave variants within guitar range (E2=40 to B5=83)
    for (let oct = 3; oct <= 6; oct++) {
      const candidate = pitchClass + oct * 12;
      if (candidate < 40 || candidate > 84) continue;
      const dist = Math.abs(candidate - prevPitch);
      if (dist < bestDist) {
        bestDist = dist;
        bestPitch = candidate;
      }
    }

    return Object.assign({}, note, { pitch: bestPitch });
  });

  // Update per-string map
  const newMap = {};
  result.forEach(n => { newMap[n.stringIndex] = n.pitch; });
  if (externalPrevPitches === undefined) previousVoicingPitches = newMap;
  return result;
}

// Get the root MIDI pitch for a chord (lowest valid note)
function getChordRootPitch(chordName) {
  const chord = CHORDS[chordName];
  if (!chord) return null;
  const validMidi = (Array.isArray(chord.midi) ? chord.midi : [])
    .filter(m => Number.isFinite(m) && m >= 0);
  if (!validMidi.length) return null;
  return Math.min(...validMidi);
}

// ===================== HITS[] GENERATION =====================
// Convert a pattern mode into an explicit hits[] array for fine-grained control
function generateHitsFromPattern(mode, bpmValue = tempo) {
  const patternDef = getStrumPattern(mode);
  if (!patternDef || patternDef.length <= 1) return null;

  const hits = patternDef.length;
  const accentMaps = {
    4: [1.0, 0.7, 0.9, 0.7],
    6: [1.0, 0.65, 0.85, 0.65, 1.0, 0.65],
    8: [1.0, 0.6, 0.85, 0.6, 1.0, 0.6, 0.9, 0.6],
    12: [1.0, 0.6, 0.85, 0.6, 1.0, 0.6, 0.9, 0.6, 1.0, 0.6, 0.85, 0.6],
  };
  const accentMap = accentMaps[hits];
  const isMute = mode.includes('mute');
  // Tempo-dependent swing cap: at high BPM, keep swing tighter
  const maxSwingNorm = bpmValue > 150 ? 0.03 : (bpmValue > 120 ? 0.12 : 0.25);
  const swingNorm = clamp(swingAmount / 70, 0, 1) * maxSwingNorm;

  return patternDef.map((hitType, i) => {
    const isGhost = isMute && i % 2 === 1;
    const accent = accentMap ? accentMap[i % accentMap.length] : 1.0;
    const vel = isGhost ? Math.round(30 * accent) : Math.round(85 * accent);
    const swing = (i % 2 === 1) ? swingNorm : 0;

    return {
      type: isGhost ? 'mute' : hitType,
      vel,
      swing,
      spread: null,
      take: isGhost ? 0.3 : 1.0,
    };
  });
}

function vibrateSingleStringByNumber(stringNumber, delay = 0) {
  const idx = clamp(Math.round(stringNumber) - 1, 0, 5);
  setTimeout(() => {
    const el = document.getElementById(`string-${idx}`);
    if (!el) return;
    el.classList.add('vibrate');
    setTimeout(() => el.classList.remove('vibrate'), 190);
  }, Math.max(0, delay));
}

function playChord(chordName, mode, beatDuration, singleStringChoice = null, stepMeta = null, trackCtx = null) {
  if (!ctx) return;
  let notes = getChordPlayableNotes(chordName, singleStringChoice);
  if (notes.length === 0) return;

  // Apply voice leading to minimize pitch jumps between consecutive chords
  if (trackCtx && trackCtx._track) {
    notes = applyVoiceLeading(notes, chordName, trackCtx._track.previousVoicingPitches);
    trackCtx._track.previousVoicingPitches = notes.map(n => n.pitch);
  } else {
    notes = applyVoiceLeading(notes, chordName);
  }
  const chordRoot = getChordRootPitch(chordName);

  const vel = (stepMeta && Number.isFinite(stepMeta.vel)) ? (stepMeta.vel / 100) : velocity;
  const noteDur = beatDuration * (mode.startsWith('pattern-') ? 1.02 : 1.12);
  const maxNoteDur = beatDuration * 0.98;
  const isMute = mode === 'mute';
  const meterModeMap = {
    'pattern-4': { hits: 4, mute: false },
    'pattern-4-mute': { hits: 4, mute: true },
    'pattern-6': { hits: 6, mute: false },
    'pattern-6-mute': { hits: 6, mute: true },
    'pattern-8': { hits: 8, mute: false },
    'pattern-8-mute': { hits: 8, mute: true },
    'pattern-12': { hits: 12, mute: false },
    'pattern-12-mute': { hits: 12, mute: true },
  };
  const meterMode = meterModeMap[mode];

  if (meterMode) {
    const patternMeta = Object.assign({ humanizeTimeMs, tightness }, stepMeta || {});
    playPatternMode(notes, beatDuration, meterMode.hits, meterMode.mute, vel, patternMeta, chordRoot, trackCtx);
    return;
  }

  if (!trackCtx && tryPlayChordNativeWebAudioFont(notes, mode, beatDuration, vel, stepMeta)) {
    return;
  }

  if (isMute) {
    notes.forEach((note, i) => {
      const t = Math.max(0, (i * 0.012) + (getTimingHumanizeMs(stepMeta, 4) / 1000));
      playNote(
        note.pitch,
        t,
        0.065,
        vel * 0.33 * (0.8 + Math.random() * 0.2),
        {
          stringIndex: note.stringIndex,
          direction: 'down',
          muted: true,
          accent: 0.9,
          stepMeta,
          releaseBias: 0.8,
          chordRoot,
        },
        trackCtx
      );
    });
    return;
  }

  // ===================== AUTHENTIC FINGERPICKING / ПЕРЕБОРИ =====================
  // Кожен перебір використовує конкретні гітарні струни (p=бас, i=3-я, m=2-а, a=1-а).
  // Бас визначається за найнижчою нотою акорду.
  if (mode === 'arpeggio' || mode === 'fingerpick' || mode === 'arpeggio-wide' || mode === 'arpeggio-slow' || mode === 'arpeggio-rev') {
    const humanMs = getEffectiveHumanizeTimeMs(stepMeta);
    const tight = getEffectiveTightness(stepMeta);

    // Визначаємо басову та альтернативну басову струну з голосоведення акорду
    const bassStr = notes[0].stringIndex + 1;              // найнижча струна в акорді
    const altBassStr = notes.length > 1 ? notes[1].stringIndex + 1 : bassStr;

    // String-specific patterns: кожне число — номер гітарної струни (6=бас, 1=тонка)
    let stringPattern, accentPattern, durPattern, skipProb = 0;

    if (mode === 'arpeggio') {
      // Класичний перебір-вісімка: p i m a m i m a
      // Бас → 3-я → 2-а → 1-а → 2-а → 3-я → 2-а → 1-а
      stringPattern = [bassStr, 3, 2, 1, 2, 3, 2, 1];
      accentPattern = [1.12, 0.72, 0.68, 0.74, 0.65, 0.70, 0.62, 0.68];
      durPattern    = [1.05, 0.88, 0.88, 0.92, 0.85, 0.85, 0.82, 0.90];
    } else if (mode === 'arpeggio-rev') {
      // Зворотній перебір: a m i p i m a p
      // 1-а → 2-а → 3-я → Бас → 3-я → 2-а → 1-а → Бас
      stringPattern = [1, 2, 3, bassStr, 3, 2, 1, bassStr];
      accentPattern = [0.92, 0.68, 0.65, 1.08, 0.65, 0.68, 0.88, 1.02];
      durPattern    = [0.90, 0.85, 0.85, 1.05, 0.85, 0.85, 0.92, 1.05];
    } else if (mode === 'fingerpick') {
      // Travis picking: чергування басу з мелодією
      // p a p' i p a p' m (Бас → 1-а → АльтБас → 3-я → Бас → 1-а → АльтБас → 2-а)
      stringPattern = [bassStr, 1, altBassStr, 3, bassStr, 1, altBassStr, 2];
      accentPattern = [1.08, 0.60, 0.95, 0.55, 1.05, 0.60, 0.92, 0.55];
      durPattern    = [1.02, 0.82, 1.02, 0.80, 1.02, 0.82, 1.02, 0.80];
    } else if (mode === 'arpeggio-slow') {
      // Повільний перебір (4 ноти, довгий сустейн): p i m a
      stringPattern = [bassStr, 3, 2, 1];
      accentPattern = [1.12, 0.75, 0.72, 0.80];
      durPattern    = [1.25, 1.18, 1.18, 1.22];
    } else { // arpeggio-wide
      // Широкий атмосферний перебір: p, 1, 3, 2, p, 1, 2, 3 (з випадковими пропусками)
      stringPattern = [bassStr, 1, 3, 2, bassStr, 1, 2, 3];
      accentPattern = [1.08, 0.62, 0.55, 0.58, 1.02, 0.60, 0.55, 0.52];
      durPattern    = [1.30, 1.15, 1.10, 1.12, 1.28, 1.15, 1.10, 1.12];
      skipProb = 0.38; // ~38% шанс пропустити слабкі долі для атмосфери
    }

    const subs = stringPattern.length;
    const baseSpacing = beatDuration / subs;
    // arpeggio-slow має ширше розведення нот
    const spacingMul = mode === 'arpeggio-slow' ? 1.45 : (mode === 'arpeggio-wide' ? 1.12 : 1.0);

    for (let i = 0; i < subs; i++) {
      // arpeggio-wide: пропускаємо деякі слабкі долі для створення простору
      if (skipProb > 0 && i > 0 && i % 2 === 1 && Math.random() < skipProb) continue;

      const note = resolvePickedNote(notes, stringPattern[i]);
      if (!note) continue;

      const baseT = i * baseSpacing * spacingMul;
      const jitterScale = mode === 'arpeggio-wide' ? 1.25 : 1.0;
      const jitter = ((Math.random() * 2 - 1) * (humanMs / 1000) * jitterScale) * (1 - tight);
      const t = Math.max(0, baseT + jitter + (getTimingHumanizeMs(stepMeta, Math.min(10, humanMs * 0.9)) / 1000));

      const accentFactor = accentPattern[i] || 1.0;
      const humanVel = Number.isFinite(stepMeta?.humanizeVel) ? stepMeta.humanizeVel : getEffectiveHumanizeVel(stepMeta);
      const velJitter = 1 + ((Math.random() * 2 - 1) * humanVel);
      const durMul = durPattern[i] || 1.0;
      const g = Math.min(1, vel * accentFactor * velJitter);

      // Басові струни грають "down" (великим пальцем), верхні — "up" (пальцями)
      const isBassString = stringPattern[i] >= 4;
      playNote(
        note.pitch,
        t,
        noteDur * durMul,
        g,
        {
          stringIndex: note.stringIndex,
          direction: isBassString ? 'down' : 'up',
          muted: false,
          maxDuration: maxNoteDur,
          stepMeta,
          releaseBias: mode === 'arpeggio-slow' ? 1.12 : 0.98,
          chordRoot,
        },
        trackCtx
      );
    }
  } else if (mode === 'strum-down') {
    const hitRatio = (stepMeta && Number.isFinite(stepMeta.patternRatio)) ? stepMeta.patternRatio : 1;
    strumStroke(notes, {
      time: Math.max(0, getTimingHumanizeMs(stepMeta, 6) / 1000),
      direction: 'down',
      duration: noteDur,
      gain: vel * 0.9,
      spread: null,
      ratio: hitRatio,
      maxDuration: maxNoteDur,
      mode: 'strum-down',
      stepMeta,
      chordRoot,
      trackCtx,
    });
  } else if (mode === 'strum-up') {
    const hitRatio = (stepMeta && Number.isFinite(stepMeta.patternRatio)) ? stepMeta.patternRatio : 1;
    strumStroke(notes, {
      time: Math.max(0, getTimingHumanizeMs(stepMeta, 7) / 1000),
      direction: 'up',
      duration: noteDur,
      gain: vel * 0.88,
      spread: null,
      ratio: hitRatio,
      maxDuration: maxNoteDur,
      mode: 'strum-up',
      stepMeta,
      chordRoot,
      trackCtx,
    });
  } else if (mode === 'strum-both') {
    strumStroke(notes, {
      time: Math.max(0, getTimingHumanizeMs(stepMeta, 6) / 1000),
      direction: 'down',
      duration: noteDur,
      gain: vel * 0.84,
      spread: null,
      ratio: 0.95,
      maxDuration: maxNoteDur,
      mode: 'strum-both',
      stepMeta,
      chordRoot,
      trackCtx,
    });
    if (beatDuration > 0.38) {
      strumStroke(notes.slice(0, 4), {
        time: Math.max(0, (beatDuration * 0.52) + (getTimingHumanizeMs(stepMeta, 9) / 1000)),
        direction: 'up',
        duration: noteDur * 0.55,
        gain: vel * 0.56,
        spread: null,
        ratio: 1,
        maxDuration: maxNoteDur * 0.55,
        mode: 'strum-up',
        stepMeta: Object.assign({}, stepMeta, { accent: Number.isFinite(stepMeta?.accent) ? stepMeta.accent : 0.95 }),
        chordRoot,
        trackCtx,
      });
    }
  } else if (mode === 'slow-strum') {
    strumStroke(notes, {
      time: Math.max(0, getTimingHumanizeMs(stepMeta, 8) / 1000),
      direction: 'down',
      duration: noteDur * 1.2,
      gain: vel * 0.9,
      spread: getStrumSpreadSeconds('slow-strum', 'down', stepMeta),
      ratio: 1,
      maxDuration: maxNoteDur,
      mode: 'slow-strum',
      stepMeta: Object.assign({}, stepMeta, { accent: Number.isFinite(stepMeta?.accent) ? stepMeta.accent : 1.02 }),
      chordRoot,
      trackCtx,
    });
  }
}

function playChordStrum(chordName, hit, durationSecs, singleStringChoice = null, trackCtx = null) {
  if (!chordName) return;
  const mode = hitToMode(hit);
  // allow passing step metadata via singleStringChoice if it's actually an object
  let stepMeta = null;
  if (singleStringChoice && typeof singleStringChoice === 'object' && !Number.isInteger(singleStringChoice)) {
    stepMeta = singleStringChoice;
    singleStringChoice = stepMeta.singleStringOverride ?? null;
  }
  playChord(chordName, mode, Math.max(0.05, durationSecs), singleStringChoice, stepMeta, trackCtx);
}

// ===================== SEQUENCER =====================
function getEffectiveMode(step) {
  if (typeof step.modeOverride === 'string' && AVAILABLE_MODES.includes(step.modeOverride)) {
    return step.modeOverride;
  }
  return strumMode;
}

function getEffectiveSingleString(step) {
  const stepOverride = parseSingleStringLoose(step?.singleStringOverride);
  if (stepOverride !== null) return stepOverride;
  return parseSingleStringLoose(singleString);
}

function getEffectivePickConfig(step, baseMode = strumMode) {
  const rawPattern = (typeof step?.pickPattern === 'string' && step.pickPattern.trim())
    ? step.pickPattern
    : pickPatternText;
  const tokens = parsePickPatternTokens(rawPattern);
  if (!tokens.length) return null;

  const beats = parsePickBeatsLoose(step?.pickBeats, pickBeats);
  if (!Number.isFinite(beats) || beats <= 0) return null;

  const fallbackThenMode = normalizeMode(baseMode, strumMode);
  const thenMode = normalizeMode(step?.pickThenMode ?? pickThenMode, fallbackThenMode);
  return {
    tokens,
    beats: clamp(beats, 0, 4),
    thenMode,
  };
}

function getEffectiveSwingAmount(step) {
  if (step && Number.isFinite(step.swingOverride)) {
    return clamp(Math.round(step.swingOverride), 0, 70);
  }
  return clamp(Math.round(swingAmount), 0, 70);
}

function getSwingOffsetMs(hitIndex, pulseMs, swingPercent) {
  if (!Number.isFinite(pulseMs) || pulseMs <= 0) return 0;
  if (!Number.isFinite(swingPercent) || swingPercent <= 0) return 0;
  if (hitIndex % 2 === 0) return 0;
  const swingNorm = clamp(swingPercent, 0, 70) / 70;
  return pulseMs * 0.32 * swingNorm;
}

function schedulePickSequence(step, notes, pickConfig, startMs, totalMs, stepMeta = null) {
  if (!step || !Array.isArray(notes) || !notes.length || !pickConfig || !Array.isArray(pickConfig.tokens)) return;
  if (totalMs <= 0) return;

  const seq = pickConfig.tokens;
  const pulseMs = totalMs / Math.max(1, seq.length);
  const velBase = (stepMeta && Number.isFinite(stepMeta.vel)) ? (stepMeta.vel / 100) : velocity;
  const accentBase = (stepMeta && Number.isFinite(stepMeta.accent)) ? stepMeta.accent : 1;
  const swingForStep = getEffectiveSwingAmount(stepMeta || step);
  const pickStepMeta = stepMeta || step;
  const pulseDuration = Math.max(0.05, (pulseMs / 1000) * 1.15);

  seq.forEach((token, idx) => {
    const swingOffset = getSwingOffsetMs(idx, pulseMs, swingForStep);
    const timingJitter = getTimingHumanizeMs(pickStepMeta, Math.min(10, pulseMs * 0.2));
    const scheduleAt = Math.max(
      0,
      Math.min(startMs + totalMs - 2, startMs + (idx * pulseMs) + swingOffset + timingJitter)
    );
    const timerId = setTimeout(() => {
      if (!isPlaying) return;
      if (token === 'mute') {
        mutedStroke(notes, 0, velBase * 0.28 * getVelocityHumanizeMultiplier(pickStepMeta, 0.5));
        return;
      }

      const note = resolvePickedNote(notes, token);
      if (!note) return;
      const hitAccent = idx % 4 === 0 ? 1.08 : 0.95;
      const hitGain = Math.min(1, velBase * accentBase * hitAccent * getVelocityHumanizeMultiplier(pickStepMeta, 0.8));
      playNote(
        note.pitch,
        0,
        pulseDuration,
        hitGain,
        {
          stringIndex: note.stringIndex,
          direction: 'down',
          muted: false,
          accent: hitAccent,
          stepMeta: pickStepMeta,
          releaseBias: 0.92,
        }
      );
      vibrateSingleStringByNumber((note.stringIndex || 0) + 1, 0);
    }, Math.round(scheduleAt));

    hitTimers.push(timerId);
  });
}

function highlightRiffNote(stepIdx, noteIdx = 0) {
  const cell = document.getElementById(`step-${stepIdx}`);
  if (!cell) return;
  cell.style.boxShadow = '0 0 15px rgba(0, 255, 204, 0.7)';
  setTimeout(() => {
    cell.style.boxShadow = '';
  }, 150 + (noteIdx * 6));
}

function triggerStep(i) {
  const audibleTracks = getAudibleTracks();
  // Multi-track mode: dispatch to each track independently
  if (audibleTracks) {
    // Highlight step (use main steps for UI)
    document.querySelectorAll('.step-cell').forEach(c => c.classList.remove('active-step'));
    const cell = document.getElementById(`step-${i}`);
    if (cell) { cell.classList.add('active-step'); cell.classList.add('playing-glow'); setTimeout(() => cell.classList.remove('playing-glow'), 500); }
    document.getElementById('statusDot').classList.add('on');
    clearHitTimers();
    const mainStep = steps[i] || { chord: '—' };
    updateChordDisplay(mainStep.chord);

    audibleTracks.forEach(track => {
      const trackSteps = getTrackSteps(track);
      const stepIdx = i % trackSteps.length;
      const tStep = trackSteps[stepIdx];
      if (!tStep || tStep.chord === '—') return;
      const tCtx = { instruments: track.instruments, volume: track.volume, _track: track };
      triggerStepForTrack(stepIdx, tStep, tCtx);
    });

    // Update loop progress
    const pct = ((i+1)/steps.length)*100;
    document.getElementById('loopProgress').style.width = pct + '%';
    return;
  }

  // Legacy single-track mode (no tracks[] defined) — original behaviour
  triggerStepLegacy(i);
}

// Per-track step trigger: plays a single step on a single track
function triggerStepForTrack(i, step, trackCtx) {
  const track = trackCtx._track;
  const mode = getEffectiveMode(step);
  const stepSingleString = getEffectiveSingleString(step);
  const barMs = bpmToMs(tempo) * getBeatsPerBar();
  const forcedHit = overrideToHit(step.strumOverride);
  const stepMeta = Object.assign({}, step, { singleStringOverride: stepSingleString });
  const chordStepMeta = Object.assign({}, stepMeta);
  const swingForStep = getEffectiveSwingAmount(stepMeta);
  const pickConfig = PLAYABLE_CHORDS.includes(step.chord) ? getEffectivePickConfig(step, mode) : null;

  // Per-track chord group — does NOT kill voices in other tracks
  track.chordGroupId++;
  const releaseMode = pickConfig ? pickConfig.thenMode : (forcedHit ? hitToMode(forcedHit) : mode);
  const releaseMs = clamp(barMs * 0.015 * getModeReleaseMultiplier(releaseMode), 16, 92);
  stopPreviousTrackVoices(track, releaseMs / 1000);

  let stageOffsetMs = 0;

  if (step.riff && Array.isArray(step.riff.frets) && step.riff.frets.length > 0) {
    const riffBeats = Math.max(1, Math.min(4, step.riffBeats ?? 1));
    const riffMs = (barMs * riffBeats) / 4;
    const noteMs = riffMs / step.riff.frets.length;
    const riffString = Math.max(1, Math.min(6, step.riff.string ?? 1));
    const baseNote = getBaseNoteForString(riffString);
    const baseVelocity = Number.isFinite(stepMeta.vel) ? (stepMeta.vel / 100) : velocity;
    const riffVelocity = Math.min(1, baseVelocity * 1.2);
    const riffStepMeta = Object.assign({}, chordStepMeta, {
      humanizeTimeMs: Math.max(0, getEffectiveHumanizeTimeMs(chordStepMeta) * 0.75),
    });

    step.riff.frets.forEach((fret, idx) => {
      const tMs = Math.max(0, Math.round(stageOffsetMs + (idx * noteMs) + getTimingHumanizeMs(riffStepMeta, Math.min(10, noteMs * 0.2))));
      const safeFret = Number.isFinite(+fret) ? Math.max(0, Math.round(+fret)) : 0;
      const pitch = baseNote + safeFret;
      const dur = Math.max(0.05, (noteMs / 1000) * 0.9);
      const hitGain = Math.min(1, riffVelocity * getVelocityHumanizeMultiplier(riffStepMeta, 0.75));

      const timerId = setTimeout(() => {
        if (!isPlaying) return;
        playNote(pitch, 0, dur, hitGain, {
          stringIndex: riffString - 1,
          direction: 'down',
          muted: false,
          accent: 1.12,
          stepMeta: riffStepMeta,
          releaseBias: 0.9,
        }, trackCtx);
      }, tMs);
      hitTimers.push(timerId);
    });

    chordStepMeta.vel = clamp(Math.round(baseVelocity * 100 * 0.8), 0, 100);
    stageOffsetMs += Math.round(riffMs);
  }

  const remainingMs = Math.max(0, barMs - stageOffsetMs);
  let pickMs = 0;
  if (pickConfig) {
    const pickNotes = getChordPlayableNotes(step.chord, null);
    if (pickNotes.length) {
      pickMs = Math.min(remainingMs, (barMs * pickConfig.beats) / getBeatsPerBar());
      if (pickMs >= 25) {
        schedulePickSequence(step, pickNotes, pickConfig, stageOffsetMs, pickMs, chordStepMeta);
      } else {
        pickMs = 0;
      }
    }
  }

  const strumStartMs = stageOffsetMs + pickMs;
  const strumMs = Math.max(0, remainingMs - pickMs);
  const activeMode = pickConfig ? pickConfig.thenMode : mode;

  let pattern;
  let explicitHits = null;
  if (Array.isArray(step.hits) && step.hits.length) {
    explicitHits = step.hits;
    pattern = step.hits.map(h => h.type || 'down');
  } else {
    const basePattern = getStrumPattern(activeMode);
    pattern = forcedHit ? basePattern.map(() => forcedHit) : basePattern;
  }

  const baseVelPct = Number.isFinite(chordStepMeta.vel)
    ? chordStepMeta.vel
    : clamp(Math.round(velocity * 100), 0, 100);
  const pulseSecs = Math.max(0.05, (strumMs / 1000) / Math.max(1, pattern.length));
  const pulseMs = strumMs / Math.max(1, pattern.length);

  if (strumMs > 5) pattern.forEach((hit, hitIndex) => {
    const hitEntry = explicitHits ? explicitHits[hitIndex] : null;
    const hitSwing = (hitEntry && hitEntry.swing !== null && hitEntry.swing !== undefined)
      ? clamp(Math.abs(hitEntry.swing) * 70, 0, 70)
      : swingForStep;
    const swingOffset = getSwingOffsetMs(hitIndex, pulseMs, hitSwing);
    const timingJitter = getTimingHumanizeMs(chordStepMeta, Math.min(14, pulseMs * 0.22));
    const scheduleAt = Math.max(
      0,
      Math.min(strumStartMs + strumMs - 2, strumStartMs + (hitIndex * pulseMs) + swingOffset + timingJitter)
    );
    const timerId = setTimeout(() => {
      if (!isPlaying) return;
      const hitVel = (hitEntry && hitEntry.vel !== null && hitEntry.vel !== undefined) ? hitEntry.vel : null;
      const velMult = getPatternHitVelocityMultiplier(activeMode, hitIndex);
      const finalVel = hitVel !== null ? hitVel : clamp(Math.round(baseVelPct * velMult), 0, 100);
      const patternRatio = getPatternHitRatio(activeMode, hitIndex);
      const stepForHit = Object.assign({}, chordStepMeta, { vel: finalVel, patternRatio });
      playChordStrum(step.chord, hit, pulseSecs, stepForHit, trackCtx);
      vibrateStrings(step.chord, hitToMode(hit), 0, stepSingleString);
    }, Math.round(scheduleAt));
    hitTimers.push(timerId);
  });
}

// Original single-track triggerStep (legacy mode w/o tracks[])
function triggerStepLegacy(i) {
  const step = steps[i];
  const mode = getEffectiveMode(step);
  const stepSingleString = getEffectiveSingleString(step);
  const barMs = bpmToMs(tempo) * getBeatsPerBar();
  const forcedHit = overrideToHit(step.strumOverride);
  const stepMeta = Object.assign({}, step, { singleStringOverride: stepSingleString });
  const chordStepMeta = Object.assign({}, stepMeta);
  const swingForStep = getEffectiveSwingAmount(stepMeta);
  const pickConfig = PLAYABLE_CHORDS.includes(step.chord) ? getEffectivePickConfig(step, mode) : null;

  // --- CHORD GROUP: increment and stop only previous group's voices ---
  currentChordGroupId++;
  let stageOffsetMs = 0;

  // Highlight step
  document.querySelectorAll('.step-cell').forEach(c => c.classList.remove('active-step'));
  const cell = document.getElementById(`step-${i}`);
  if (cell) { cell.classList.add('active-step'); cell.classList.add('playing-glow'); setTimeout(() => cell.classList.remove('playing-glow'), 500); }

  // Update display
  updateChordDisplay(step.chord);

  // Status
  document.getElementById('statusDot').classList.add('on');
  clearHitTimers();
  // Smart voice stop: only kill voices from previous chord group (preserves reverb tails)
  const releaseMode = pickConfig ? pickConfig.thenMode : (forcedHit ? hitToMode(forcedHit) : mode);
  const releaseMs = clamp(barMs * 0.015 * getModeReleaseMultiplier(releaseMode), 16, 92);
  stopPreviousChordVoices(releaseMs / 1000);

  if (step.riff && Array.isArray(step.riff.frets) && step.riff.frets.length > 0) {
    const riffBeats = Math.max(1, Math.min(4, step.riffBeats ?? 1));
    const riffMs = (barMs * riffBeats) / 4;
    const noteMs = riffMs / step.riff.frets.length;
    const riffString = Math.max(1, Math.min(6, step.riff.string ?? 1));
    const baseNote = getBaseNoteForString(riffString);
    const baseVelocity = Number.isFinite(stepMeta.vel) ? (stepMeta.vel / 100) : velocity;
    const riffVelocity = Math.min(1, baseVelocity * 1.2);
    const riffStepMeta = Object.assign({}, chordStepMeta, {
      humanizeTimeMs: Math.max(0, getEffectiveHumanizeTimeMs(chordStepMeta) * 0.75),
    });

    step.riff.frets.forEach((fret, idx) => {
      const tMs = Math.max(0, Math.round(stageOffsetMs + (idx * noteMs) + getTimingHumanizeMs(riffStepMeta, Math.min(10, noteMs * 0.2))));
      const safeFret = Number.isFinite(+fret) ? Math.max(0, Math.round(+fret)) : 0;
      const pitch = baseNote + safeFret;
      const dur = Math.max(0.05, (noteMs / 1000) * 0.9);
      const hitGain = Math.min(1, riffVelocity * getVelocityHumanizeMultiplier(riffStepMeta, 0.75));

      const timerId = setTimeout(() => {
        if (!isPlaying) return;
        playNote(pitch, 0, dur, hitGain, {
          stringIndex: riffString - 1,
          direction: 'down',
          muted: false,
          accent: 1.12,
          stepMeta: riffStepMeta,
          releaseBias: 0.9,
        });
        highlightRiffNote(i, idx);
      }, tMs);

      hitTimers.push(timerId);
    });

    chordStepMeta.vel = clamp(Math.round(baseVelocity * 100 * 0.8), 0, 100);
    stageOffsetMs += Math.round(riffMs);
  }

  const remainingMs = Math.max(0, barMs - stageOffsetMs);
  let pickMs = 0;
  if (pickConfig) {
    const pickNotes = getChordPlayableNotes(step.chord, null);
    if (pickNotes.length) {
      pickMs = Math.min(remainingMs, (barMs * pickConfig.beats) / getBeatsPerBar());
      if (pickMs >= 25) {
        schedulePickSequence(step, pickNotes, pickConfig, stageOffsetMs, pickMs, chordStepMeta);
      } else {
        pickMs = 0;
      }
    }
  }

  // --- STRUM PART (remaining beats) ---
  const strumStartMs = stageOffsetMs + pickMs;
  const strumMs = Math.max(0, remainingMs - pickMs);
  const activeMode = pickConfig ? pickConfig.thenMode : mode;

  // --- HITS[] INTEGRATION: use explicit hits[] if present, else resolve from pattern ---
  let pattern;
  let explicitHits = null;
  if (Array.isArray(step.hits) && step.hits.length) {
    explicitHits = step.hits;
    pattern = step.hits.map(h => h.type || 'down');
  } else {
    const basePattern = getStrumPattern(activeMode);
    pattern = forcedHit ? basePattern.map(() => forcedHit) : basePattern;
  }

  const baseVelPct = Number.isFinite(chordStepMeta.vel)
    ? chordStepMeta.vel
    : clamp(Math.round(velocity * 100), 0, 100);
  const pulseSecs = Math.max(0.05, (strumMs / 1000) / Math.max(1, pattern.length));
  const pulseMs = strumMs / Math.max(1, pattern.length);

  if (strumMs > 5) pattern.forEach((hit, hitIndex) => {
    const hitEntry = explicitHits ? explicitHits[hitIndex] : null;
    // Use hit-level swing if provided, otherwise step-level
    const hitSwing = (hitEntry && hitEntry.swing !== null && hitEntry.swing !== undefined)
      ? clamp(Math.abs(hitEntry.swing) * 70, 0, 70)
      : swingForStep;
    const swingOffset = getSwingOffsetMs(hitIndex, pulseMs, hitSwing);
    const timingJitter = getTimingHumanizeMs(chordStepMeta, Math.min(14, pulseMs * 0.22));
    const scheduleAt = Math.max(
      0,
      Math.min(strumStartMs + strumMs - 2, strumStartMs + (hitIndex * pulseMs) + swingOffset + timingJitter)
    );
    const timerId = setTimeout(() => {
      if (!isPlaying) return;
      // Hit-level velocity: explicit hits[] vel overrides pattern multiplier
      const hitVel = (hitEntry && hitEntry.vel !== null && hitEntry.vel !== undefined) ? hitEntry.vel : null;
      const velMult = getPatternHitVelocityMultiplier(activeMode, hitIndex);
      const finalVel = hitVel !== null ? hitVel : clamp(Math.round(baseVelPct * velMult), 0, 100);
      const patternRatio = getPatternHitRatio(activeMode, hitIndex);
      const stepForHit = Object.assign({}, chordStepMeta, { vel: finalVel, patternRatio });
      playChordStrum(step.chord, hit, pulseSecs, stepForHit);
      vibrateStrings(step.chord, hitToMode(hit), 0, stepSingleString);
    }, Math.round(scheduleAt));
    hitTimers.push(timerId);
  });

  // Update loop progress
  const pct = ((i+1)/steps.length)*100;
  document.getElementById('loopProgress').style.width = pct + '%';
}

function playStep(stepIndex) {
  triggerStep(stepIndex);
}

console.log('Melody patch applied: riff priority and fast attack enabled.');

function updateChordDisplay(chord) {
  document.getElementById('currentChordDisplay').textContent = chord === '—' ? '—' : chord;
  drawChordDiagram(chord);
}

async function startSequencer() {
  if (isPlaying || isStarting) return;
  isStarting = true;
  try {
    await initAudio();

    if (wafPlayer && !hasAnyLoadedInstrument()) {
      setInfoText('⏳ Довантаження семплів...');
      await waitForInstrumentLoad(1800);
      if (!hasAnyLoadedInstrument()) {
        flashStatus('Семпли ще вантажаться, тимчасово fallback', 2200);
      }
    }

    isPlaying = true;
    clearHitTimers();
    document.getElementById('playBtn').classList.add('playing');
    document.getElementById('playBtn').textContent = '⏸';
    setTransportState('playing');

    currentStep = 0;
    previousVoicingPitches = null; // reset voice leading on new playback
    currentChordGroupId = 0;
    // Reset per-track playback state
    tracks.forEach(t => {
      t.chordGroupId = 0;
      t.activeVoices = [];
      t.previousVoicingPitches = null;
    });
    // Start lookahead scheduler
    startLookaheadScheduler();
  } finally {
    isStarting = false;
  }
}

// ===================== LOOKAHEAD SCHEDULER =====================
// Replaces the old setTimeout-chain scheduler with a polling-based lookahead.
// A setInterval(25ms) tick checks if any steps fall within the lookahead window
// and fires them at the right time. This eliminates cumulative drift and reduces
// jitter compared to recursive setTimeout scheduling.

function startLookaheadScheduler() {
  stopLookaheadScheduler();
  nextStepAudioTime = performance.now() + 30; // small initial delay
  nextStepIndex = currentStep;
  schedulerTick(); // fire immediately to start
  schedulerIntervalId = setInterval(schedulerTick, SCHEDULER_TICK_MS);
}

function stopLookaheadScheduler() {
  if (schedulerIntervalId) {
    clearInterval(schedulerIntervalId);
    schedulerIntervalId = null;
  }
}

function schedulerTick() {
  if (!isPlaying) return;
  const nowMs = performance.now();
  const barMs = bpmToMs(tempo) * getBeatsPerBar();

  // Fire any steps whose time has arrived or is within lookahead window
  while (nextStepAudioTime <= nowMs + SCHEDULER_LOOKAHEAD_MS) {
    const delayMs = Math.max(0, nextStepAudioTime - nowMs);
    const stepIdx = nextStepIndex;

    if (delayMs <= SCHEDULER_TICK_MS) {
      // Fire now (within one tick)
      currentStep = stepIdx;
      playStep(stepIdx);
    } else {
      // Schedule via setTimeout for precise firing
      const timerId = setTimeout(() => {
        if (!isPlaying) return;
        currentStep = stepIdx;
        playStep(stepIdx);
      }, Math.round(delayMs));
      hitTimers.push(timerId);
    }

    nextStepAudioTime += barMs;
    nextStepIndex = (nextStepIndex + 1) % steps.length;
  }
}

function pauseSequencer() {
  isPlaying = false;
  isStarting = false;
  stopLookaheadScheduler();
  clearTimeout(playInterval);
  clearHitTimers();
  stopActiveVoices(0.02);
  document.getElementById('playBtn').classList.remove('playing');
  document.getElementById('playBtn').textContent = '▶';
  setTransportState('paused');
  document.getElementById('statusDot').classList.remove('on');
}

function stopSequencer() {
  isPlaying = false;
  isStarting = false;
  stopLookaheadScheduler();
  clearTimeout(playInterval);
  clearHitTimers();
  stopActiveVoices(0.012);
  stopAllTrackVoices(0.012);
  currentStep = 0;
  previousVoicingPitches = null; // reset voice leading
  currentChordGroupId = 0;
  tracks.forEach(t => { t.chordGroupId = 0; t.activeVoices = []; t.previousVoicingPitches = null; });
  document.getElementById('playBtn').classList.remove('playing');
  document.getElementById('playBtn').textContent = '▶';
  setTransportState('stopped');
  document.getElementById('statusDot').classList.remove('on');
  document.getElementById('loopProgress').style.width = '0%';
  document.querySelectorAll('.step-cell').forEach(c => c.classList.remove('active-step'));
  document.getElementById('currentChordDisplay').textContent = '—';
  drawChordDiagram('—');
}

// ===================== CONTROLS =====================
document.getElementById('playBtn').addEventListener('click', () => {
  if (isPlaying) pauseSequencer();
  else startSequencer();
});

document.getElementById('stopBtn').addEventListener('click', stopSequencer);

document.getElementById('tempoSlider').addEventListener('input', e => {
  tempo = parseInt(e.target.value);
  document.getElementById('bpmDisplay').textContent = tempo;
  const pct = (tempo-40)/(200-40)*100;
  e.target.style.setProperty('--v', pct + '%');
});

document.getElementById('volSlider').addEventListener('input', e => {
  volume = parseInt(e.target.value) / 100;
  document.getElementById('volDisplay').textContent = parseInt(e.target.value);
  if (masterGain) masterGain.gain.value = volume;
  const pct = parseInt(e.target.value);
  e.target.style.setProperty('--v', pct + '%');
});

document.getElementById('velSlider').addEventListener('input', e => {
  velocity = parseInt(e.target.value) / 100;
  document.getElementById('velDisplay').textContent = parseInt(e.target.value);
  const pct = parseInt(e.target.value);
  e.target.style.setProperty('--v', pct + '%');
  setCustomPlayStyle();
});

document.getElementById('swingSlider').addEventListener('input', e => {
  swingAmount = parseInt(e.target.value);
  document.getElementById('swingDisplay').textContent = swingAmount;
  const pct = swingAmount / 70 * 100;
  e.target.style.setProperty('--v', pct + '%');
  setCustomPlayStyle();
});

// Sync song bars select with sequencer length
const songBarsSelect = document.getElementById('songBarsInput');
if (songBarsSelect) {
  songBarsSelect.addEventListener('change', e => {
    const v = parseInt(e.target.value, 10) || 16;
    const newSteps = clamp(v, MIN_STEPS, MAX_STEPS);
    if (newSteps === numSteps) return;
    numSteps = newSteps;
    syncChordCountButtons();
    if (isPlaying) stopSequencer();
    initSteps(numSteps);
    updateChordDisplay(steps[0] ? steps[0].chord : '—');
    flashStatus(`Кількість тактів встановлено: ${numSteps}`, 1400);
  });
}

// CHORD COUNT BUTTONS
document.getElementById('countBtns').addEventListener('click', e => {
  if (!e.target.dataset.n) return;
  const n = parseInt(e.target.dataset.n);
  numSteps = n;
  setSongBarsSelectValue(n);
  syncChordCountButtons();
  if (isPlaying) stopSequencer();
  initSteps(n);
  updateChordDisplay(steps[0] ? steps[0].chord : '—');
});

// QUICK ACTIONS
document.getElementById('presetBtn').addEventListener('click', () => {
  applyPattern(['C','G','Am','F']);
  flashStatus('Застосовано пресет I–V–vi–IV');
});
document.getElementById('unforgivenBtn').addEventListener('click', applyTheUnforgivenPreset);
document.getElementById('armyNowBtn').addEventListener('click', applyInTheArmyNowPreset);
const nonStopFixBtn = document.getElementById('nonStopFixBtn');
if (nonStopFixBtn) {
  nonStopFixBtn.addEventListener('click', () => applyNonStopCleanup());
}

document.getElementById('randomBtn').addEventListener('click', randomizePattern);
document.getElementById('clearBtn').addEventListener('click', clearPattern);
document.getElementById('saveBtn').addEventListener('click', savePattern);
const instrumentButtonsEl = document.getElementById('instrumentButtons');
// Click handling is now done inside renderInstrumentButtons() via direct listeners
document.getElementById('buildPromptBtn').addEventListener('click', () => {
  const settings = collectPromptSettings();
  const prompt = buildSongPrompt(settings.songName, settings);
  document.getElementById('promptOutput').value = prompt;
  flashStatus('Промпт згенеровано');
});
document.getElementById('tabToPromptBtn').addEventListener('click', () => {
  const settings = collectPromptSettings();
  const prompt = buildSongPrompt(settings.songName, settings);
  document.getElementById('promptOutput').value = prompt;
  if (settings.parsedTabProgression.length) {
    flashStatus(`Таба додана в промпт (${settings.parsedTabProgression.length} акордів)`, 2200);
  } else {
    flashStatus('Промпт оновлено, але табу не розпізнано', 2200);
  }
});
document.getElementById('importTabBtn').addEventListener('click', () => {
  importTabInputToProgram();
});
document.getElementById('copyPromptBtn').addEventListener('click', async () => {
  const prompt = document.getElementById('promptOutput').value.trim();
  if (!prompt) {
    flashStatus('Спочатку згенеруй промпт');
    return;
  }
  try {
    await copyTextToClipboard(prompt);
    flashStatus('Промпт скопійовано');
  } catch (err) {
    flashStatus('Не вдалося скопіювати', 1800);
  }
});
document.getElementById('askAiBtn').addEventListener('click', requestAiScript);
document.getElementById('applyJsonBtn').addEventListener('click', () => {
  const raw = document.getElementById('jsonScriptInput').value.trim();
  if (!raw) {
    flashStatus('Встав JSON скрипт');
    return;
  }
  try {
    const scriptObj = extractJsonObjectFromText(raw);
    try {
      applyScriptObject(scriptObj);
    } catch (errApply) {
      // Try to auto-fix common issues (mismatched steps length, stray chords, etc.)
      try {
        const fixed = autoFixScriptObject(scriptObj);
        applyScriptObject(fixed);
        // update textarea to show fixed JSON
        document.getElementById('jsonScriptInput').value = JSON.stringify(fixed, null, 2);
        flashStatus('JSON автоматично виправлено і застосовано', 2200);
      } catch (err2) {
        throw errApply;
      }
    }
  } catch (err) {
    flashStatus(`JSON помилка: ${err.message}`, 2400);
  }
});
document.getElementById('exportJsonBtn').addEventListener('click', () => {
  exportCurrentScript();
});

// MODE BUTTONS
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setStrumMode(btn.dataset.mode);
    setCustomPlayStyle();
  });
});

document.getElementById('singleStringSelect').addEventListener('change', e => {
  singleString = parseSingleStringLoose(e.target.value);
  updateSingleStringUI();
  flashStatus(singleString === null ? 'All strings active' : `One string mode: ${singleString}`, 1300);
});

const playStyleSelect = document.getElementById('playStyleSelect');
if (playStyleSelect) {
  playStyleSelect.addEventListener('change', e => {
    applyStylePreset(e.target.value);
  });
}

const applyStyleBtn = document.getElementById('applyStyleBtn');
if (applyStyleBtn) {
  applyStyleBtn.addEventListener('click', () => {
    const selected = document.getElementById('playStyleSelect')?.value || 'custom';
    applyStylePreset(selected);
  });
}

const pickPatternInput = document.getElementById('pickPatternInput');
if (pickPatternInput) {
  pickPatternInput.addEventListener('change', e => {
    pickPatternText = normalizePickPatternText(e.target.value || '');
    updatePickPatternUI();
    setCustomPlayStyle();
    flashStatus(pickPatternText ? `Pick pattern: ${pickPatternText}` : 'Pick pattern cleared', 1500);
  });
}

const pickBeatsInput = document.getElementById('pickBeatsInput');
if (pickBeatsInput) {
  pickBeatsInput.addEventListener('input', e => {
    pickBeats = parsePickBeatsLoose(e.target.value, pickBeats);
    updatePickBeatsUI();
    setCustomPlayStyle();
  });
}

const pickThenModeSelect = document.getElementById('pickThenModeSelect');
if (pickThenModeSelect) {
  pickThenModeSelect.addEventListener('change', e => {
    pickThenMode = normalizeMode(e.target.value, pickThenMode);
    updatePickThenModeUI();
    setCustomPlayStyle();
  });
}

// KEYBOARD SHORTCUTS
document.addEventListener('keydown', e => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (isPlaying) pauseSequencer();
    else startSequencer();
  }
  if (e.code === 'Escape') stopSequencer();
  if (e.code === 'KeyR') randomizePattern();
});

// INIT
initSteps(8);
setSongBarsSelectValue(8);
buildStringsDisplay();
syncChordCountButtons();
populateStyleControls();
renderInstrumentButtons();
updatePlayStyleUI();
updatePickingUI();
setStrumMode(strumMode);
updateSingleStringUI();
setActiveInstruments(activeInstruments, { quiet: true });
if (typeof WebAudioFontPlayer === 'function') setInfoText('⏳ Семпли готові до завантаження');
else setInfoText('⚠ WebAudioFont не знайдено, fallback синтез');
setTransportState('stopped');
if (loadPattern()) flashStatus('Завантажено останній патерн');
else updateChordDisplay('—');

// Init range display
updateTempoUI();
updateVolumeUI();
updateVelocityUI();
updateSwingUI();
renderTracksUI();
