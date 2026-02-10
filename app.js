/* global kuromoji, Plotly */

const DIC_PATH = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";
const COORDS_CSV = "./model/coords.csv";
const VOCAB_JSON = "./model/vocab.json";
const VEC_BIN = "./model/vec50.bin"; // SIM_D=50で作った場合

const SIM_D = 50;

const els = {
  text: document.getElementById("textInput"),
  run: document.getElementById("runBtn"),
  status: document.getElementById("status"),
  plot: document.getElementById("plot"),
  posFilter: document.getElementById("posFilter"),
  uniqueOnly: document.getElementById("uniqueOnly"),
  selectedWord: document.getElementById("selectedWord"),
  simList: document.getElementById("simList"),
};

let tokenizer = null;

// word -> {x,y}
let coordMap = new Map();

// vocab list and word->index
let vocab = [];
let wordToIndex = new Map();

// Float32Array length = vocab.length * SIM_D
let vecData = null;

// current plotted words
let currentWords = [];
let currentXY = []; // [[x,y],...]

function setStatus(msg) { els.status.textContent = msg; }

function cosineSimByIndex(i, j) {
  const offI = i * SIM_D;
  const offJ = j * SIM_D;
  let dot = 0, ni = 0, nj = 0;
  for (let k = 0; k < SIM_D; k++) {
    const a = vecData[offI + k];
    const b = vecData[offJ + k];
    dot += a * b;
    ni += a * a;
    nj += b * b;
  }
  if (ni === 0 || nj === 0) return 0;
  return dot / (Math.sqrt(ni) * Math.sqrt(nj));
}

function isTargetPOS(t) {
  return t.pos === "名詞" || t.pos === "動詞" || t.pos === "形容詞";
}

async function loadTokenizer() {
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: DIC_PATH }).build((err, tk) => {
      if (err) reject(err);
      else resolve(tk);
    });
  });
}

async function loadVocabAndVec() {
  setStatus("語彙を読み込み中…");
  const v = await (await fetch(VOCAB_JSON)).json();
  vocab = v;
  wordToIndex = new Map(vocab.map((w, i) => [w, i]));

  setStatus("圧縮ベクトル(vec50.bin)を読み込み中…");
  const buf = await (await fetch(VEC_BIN)).arrayBuffer();
  vecData = new Float32Array(buf);

  const expected = vocab.length * SIM_D;
  if (vecData.length !== expected) {
    throw new Error(`vec bin size mismatch: got ${vecData.length}, expected ${expected}`);
  }
}

function parseCSVLine(line) {
  // word,x,y（wordにカンマが含まれるケースは基本想定しない）
  const parts = line.split(",");
  return parts;
}

async function loadCoords() {
  setStatus("座標(coords.csv)を読み込み中…");
  const txt = await (await fetch(COORDS_CSV)).text();
  const lines = txt.split(/\r?\n/).filter(l => l.trim().length > 0);
  // header: word,x,y
  for (let i = 1; i < lines.length; i++) {
    const [word, x, y] = parseCSVLine(lines[i]);
    if (!word) continue;
    const xx = Number(x), yy = Number(y);
    if (Number.isFinite(xx) && Number.isFinite(yy)) {
      coordMap.set(word, { x: xx, y: yy });
    }
  }
}

function tokenize(text) {
  const tokens = tokenizer.tokenize(text);
  const out = [];
  for (const t of tokens) {
    if (els.posFilter.checked && !isTargetPOS(t)) continue;
    const w = (t.basic_form && t.basic_form !== "*") ? t.basic_form : t.surface_form;
    if (!w || !w.trim()) continue;
    out.push(w);
  }
  return out;
}

function renderPlot(words, xy) {
  const xs = xy.map(p => p[0]);
  const ys = xy.map(p => p[1]);

  Plotly.newPlot(els.plot, [{
    x: xs, y: ys,
    mode: "markers+text",
    type: "scatter",
    text: words,
    textposition: "top center",
    hoverinfo: "text",
    marker: { size: 10, opacity: 0.85 }
  }], {
    margin: { l: 30, r: 10, t: 10, b: 30 },
    showlegend: false
  }, { responsive: true });

  els.plot.on("plotly_click", (data) => {
    const idx = data.points?.[0]?.pointIndex;
    if (idx == null) return;
    showSimilar(words[idx]);
  });
}

function showSimilar(word) {
  els.selectedWord.textContent = word;
  els.simList.innerHTML = "";

  const idx = wordToIndex.get(word);
  if (idx == null) return;

  // 「入力内の単語だけ」から類似語TOP10
  const candidates = currentWords
    .filter(w => w !== word)
    .map(w => {
      const j = wordToIndex.get(w);
      if (j == null) return null;
      return { w, s: cosineSimByIndex(idx, j) };
    })
    .filter(Boolean)
    .sort((a, b) => b.s - a.s)
    .slice(0, 10);

  for (const { w, s } of candidates) {
    const li = document.createElement("li");
    li.textContent = `${w}（類似度: ${s.toFixed(3)}）`;
    els.simList.appendChild(li);
  }
}

async function run() {
  const text = (els.text.value || "").trim();
  if (!text) { alert("テキストを入力してください。"); return; }

  els.run.disabled = true;
  setStatus("分かち書き中…");

  let words = tokenize(text);
  if (els.uniqueOnly.checked) words = [...new Set(words)];

  // coords.csv にある語だけ残す（＝プロットできる語）
  const kept = [];
  const xy = [];
  for (const w of words) {
    const c = coordMap.get(w);
    if (!c) continue;
    // 類似語用ベクトルもある語だけに絞る
    if (!wordToIndex.has(w)) continue;
    kept.push(w);
    xy.push([c.x, c.y]);
  }

  if (kept.length < 2) {
    setStatus("プロット可能な単語が少なすぎます（2語以上必要）。");
    els.run.disabled = false;
    return;
  }

  currentWords = kept;
  currentXY = xy;

  setStatus(`完了：${kept.length}語をプロット`);
  renderPlot(kept, xy);
  showSimilar(kept[0]);

  els.run.disabled = false;
}

async function init() {
  try {
    els.run.disabled = true;
    setStatus("形態素解析辞書を読み込み中…");
    tokenizer = await loadTokenizer();

    await loadCoords();
    await loadVocabAndVec();

    setStatus("準備完了");
    els.run.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("初期化エラー：コンソールを確認してください");
    alert("初期化に失敗しました。パスやファイル内容を確認してください。");
  }
}

els.run.addEventListener("click", run);
init();
