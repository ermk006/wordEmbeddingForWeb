// ========== 設定 ==========
const COORDS_CSV = "./model/coords.csv";
const VOCAB_JSON = "./model/vocab.json";
const VEC_BIN    = "./model/vec50.bin";
const SIM_D = 50;

const PLOTLY_URL  = "https://cdn.plot.ly/plotly-2.32.0.min.js";
const KUROMOJI_URL= "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.min.js";
const DIC_PATH    = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";

// ========== DOM ==========
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

function setStatus(msg) { els.status.textContent = msg; }

// ========== 遅延ロード状態 ==========
let libsLoaded = false;
let tokenizer = null;

let coordsLoaded = false;
let coordMap = new Map(); // word -> {x,y}

let simLoaded = false;
let wordToIndex = new Map();
let vecData = null;
let currentWords = [];

// ========== ユーティリティ ==========
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    // すでに読み込まれているなら即resolve
    if ([...document.scripts].some(s => s.src === src)) return resolve();

    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load: ${src}`));
    document.head.appendChild(s);
  });
}

function tokenizeText(text) {
  const tokens = tokenizer.tokenize(text);
  const out = [];
  for (const t of tokens) {
    if (els.posFilter.checked) {
      const ok = (t.pos === "名詞" || t.pos === "動詞" || t.pos === "形容詞");
      if (!ok) continue;
    }
    const w = (t.basic_form && t.basic_form !== "*") ? t.basic_form : t.surface_form;
    if (!w || !w.trim()) continue;
    out.push(w);
  }
  return out;
}

function parseCSVLine(line) {
  // word,x,y 前提（wordにカンマが入らない想定）
  return line.split(",");
}

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

// ========== 遅延ロード本体 ==========
async function ensureLibsAndTokenizer() {
  if (tokenizer) return;

  setStatus("ライブラリ読込中…（初回のみ）");
  await loadScriptOnce(PLOTLY_URL);
  await loadScriptOnce(KUROMOJI_URL);

  setStatus("形態素解析準備中…（初回のみ）");
  tokenizer = await new Promise((resolve, reject) => {
    // kuromoji はグローバルに kuromoji が生える
    window.kuromoji.builder({ dicPath: DIC_PATH }).build((err, tk) => {
      if (err) reject(err);
      else resolve(tk);
    });
  });

  setStatus("準備完了");
}

async function ensureCoords() {
  if (coordsLoaded) return;

  setStatus("座標(coords.csv)読込中…（初回のみ）");
  const txt = await (await fetch(COORDS_CSV, { cache: "force-cache" })).text();
  const lines = txt.split(/\r?\n/).filter(l => l.trim().length > 0);

  // header skip
  for (let i = 1; i < lines.length; i++) {
    const [word, x, y] = parseCSVLine(lines[i]);
    if (!word) continue;
    const xx = Number(x), yy = Number(y);
    if (Number.isFinite(xx) && Number.isFinite(yy)) coordMap.set(word, { x: xx, y: yy });
  }
  coordsLoaded = true;
}

async function ensureSimModel() {
  if (simLoaded) return;

  setStatus("類似語モデル読込中…（初回のみ）");
  const vocab = await (await fetch(VOCAB_JSON, { cache: "force-cache" })).json();
  wordToIndex = new Map(vocab.map((w, i) => [w, i]));

  const buf = await (await fetch(VEC_BIN, { cache: "force-cache" })).arrayBuffer();
  vecData = new Float32Array(buf);

  const expected = vocab.length * SIM_D;
  if (vecData.length !== expected) throw new Error(`vec50.bin サイズ不一致: got ${vecData.length}, expected ${expected}`);

  simLoaded = true;
}

// ========== 描画 ==========
function renderPlot(words, xy) {
  const xs = xy.map(p => p[0]);
  const ys = xy.map(p => p[1]);

  window.Plotly.newPlot(els.plot, [{
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

  els.plot.on("plotly_click", async (data) => {
    const idx = data.points?.[0]?.pointIndex;
    if (idx == null) return;
    await showSimilar(words[idx]);
  });
}

async function showSimilar(word) {
  els.selectedWord.textContent = word;
  els.simList.innerHTML = "";

  await ensureSimModel();

  const i = wordToIndex.get(word);
  if (i == null) return;

  const sims = currentWords
    .filter(w => w !== word && wordToIndex.has(w))
    .map(w => ({ w, s: cosineSimByIndex(i, wordToIndex.get(w)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 10);

  for (const { w, s } of sims) {
    const li = document.createElement("li");
    li.textContent = `${w}（類似度: ${s.toFixed(3)}）`;
    els.simList.appendChild(li);
  }
}

// ========== 実行 ==========
async function run() {
  const text = (els.text.value || "").trim();
  if (!text) { alert("テキストを入力してください。"); return; }

  els.run.disabled = true;
  try {
    // ★ここが重要：ページ表示時にやらず、クリック時に初回ロード
    await ensureLibsAndTokenizer();

    setStatus("分かち書き中…");
    let words = tokenizeText(text);
    if (els.uniqueOnly.checked) words = [...new Set(words)];

    await ensureCoords();

    const kept = [];
    const xy = [];
    for (const w of words) {
      const c = coordMap.get(w);
      if (!c) continue;
      kept.push(w);
      xy.push([c.x, c.y]);
    }

    if (kept.length < 2) {
      setStatus("プロット可能な単語が少なすぎます（2語以上必要）。");
      return;
    }

    currentWords = kept;
    setStatus(`完了：${kept.length}語をプロット（類似語はクリックで初回ロード）`);
    renderPlot(kept, xy);

  } catch (e) {
    console.error(e);
    alert("エラーが発生しました。Console を確認してください。");
    setStatus("エラー（Console参照）");
  } finally {
    els.run.disabled = false;
  }
}

// 初期化：何もしない（固まり防止）
setStatus("準備完了（ボタンで開始）");
els.run.addEventListener("click", run);
