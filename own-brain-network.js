"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Own Brain: Neural Network Core
//
// This is a REAL, from-scratch, character-level recurrent neural
// network language model. No pretrained weights, no wrapper around
// Ollama/Groq/anything else — just linear algebra and calculus,
// trained on whatever JARVIS has actually been taught.
//
// It's the same algorithm family Karpathy's famous "min-char-rnn"
// popularized: a single-layer RNN trained with full
// backpropagation-through-time (BPTT) and Adagrad. Nothing fancy,
// nothing hidden — every line of math below IS the model. It starts
// out knowing literally nothing (random weights) and only gets
// better by actually training on real text you feed it via
// own-brain.js.
//
// Being honest about what this is: a small RNN trained on a
// laptop CPU on a few thousand short Q/A pairs will NOT write
// essays or reason like Groq/GPT-class models. It's a genuinely
// "yours" brain that grows slowly. Treat its raw generations as a
// low-confidence fallback — own-brain.js leans on exact/near-exact
// memory retrieval first, and only trusts free generation once
// there's real training volume behind it.
// ═══════════════════════════════════════════════════════════════

// ── FIXED VOCABULARY ──────────────────────────────────────────
// Printable ASCII (32–126) + newline + tab + <UNK>. Keeping the
// vocab fixed-size means we never have to resize weight matrices
// on the fly (a common source of subtle bugs in "grow as you go"
// tokenizers). Anything outside this set (emoji, accents, CJK,
// etc.) maps to <UNK> — the model just won't reproduce those
// exactly, which is a fine trade for a small hobby model.
const CHARS = [];
for (let c = 32; c <= 126; c++) CHARS.push(String.fromCharCode(c));
CHARS.push("\n", "\t");
const UNK = "\u0000"; // internal sentinel, never appears in real text
CHARS.push(UNK);

const VOCAB_SIZE = CHARS.length;
const CHAR_TO_IX = {};
CHARS.forEach((ch, i) => { CHAR_TO_IX[ch] = i; });
const UNK_IX = CHAR_TO_IX[UNK];

function textToIndices(text) {
  const out = new Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const ix = CHAR_TO_IX[text[i]];
    out[i] = ix === undefined ? UNK_IX : ix;
  }
  return out;
}
function indexToChar(ix) {
  return CHARS[ix] === UNK ? "" : CHARS[ix];
}

// ── MATRIX HELPERS ────────────────────────────────────────────
function zerosMat(rows, cols) {
  const m = new Array(rows);
  for (let i = 0; i < rows; i++) m[i] = new Float64Array(cols);
  return m;
}
function zerosVec(n) { return new Float64Array(n); }

// Box-Muller for a small random-normal draw, scaled down like
// Karpathy's randn(...) * 0.01 initialization.
function randn(scale) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return scale * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function randMat(rows, cols, scale) {
  const m = zerosMat(rows, cols);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) m[i][j] = randn(scale);
  return m;
}

// M (rows x cols) @ v (cols) -> (rows)
function matVec(M, v, rows, cols) {
  const out = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    let s = 0;
    const row = M[i];
    for (let j = 0; j < cols; j++) s += row[j] * v[j];
    out[i] = s;
  }
  return out;
}
// M^T (cols x rows) @ v (rows) -> (cols)   [M is rows x cols]
function matTVec(M, v, rows, cols) {
  const out = new Float64Array(cols);
  for (let i = 0; i < rows; i++) {
    const row = M[i];
    const vi = v[i];
    if (vi === 0) continue;
    for (let j = 0; j < cols; j++) out[j] += row[j] * vi;
  }
  return out;
}
function clip(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// ── THE MODEL ──────────────────────────────────────────────────
class RNNLanguageModel {
  constructor(hiddenSize = 128) {
    this.hiddenSize = hiddenSize;
    this.vocabSize = VOCAB_SIZE;

    // Parameters — same names/shapes as the classic min-char-rnn.
    this.Wxh = randMat(hiddenSize, VOCAB_SIZE, 0.01); // input  -> hidden
    this.Whh = randMat(hiddenSize, hiddenSize, 0.01); // hidden -> hidden
    this.Why = randMat(VOCAB_SIZE, hiddenSize, 0.01); // hidden -> output
    this.bh  = zerosVec(hiddenSize);
    this.by  = zerosVec(VOCAB_SIZE);

    // Adagrad memory (persisted so learning rate adapts sensibly
    // across sessions, not just within one process's lifetime).
    this.mWxh = zerosMat(hiddenSize, VOCAB_SIZE);
    this.mWhh = zerosMat(hiddenSize, hiddenSize);
    this.mWhy = zerosMat(VOCAB_SIZE, hiddenSize);
    this.mbh  = zerosVec(hiddenSize);
    this.mby  = zerosVec(VOCAB_SIZE);

    this.learningRate = 0.08;
    this.totalCharsTrained = 0;
    this.smoothLoss = -Math.log(1.0 / VOCAB_SIZE); // expected loss for a random model
  }

  // One BPTT pass over `inputs`/`targets` (equal-length arrays of
  // char indices), given the previous hidden state. Returns the
  // loss and the new hidden state; also applies the Adagrad update
  // in place. This IS the model learning — real forward pass,
  // real gradients, real weight update.
  _step(inputs, targets, hprev) {
    const T = inputs.length;
    const H = this.hiddenSize, V = this.vocabSize;
    const xs = inputs, hs = new Array(T), ys = new Array(T), ps = new Array(T);
    let hPrevT = hprev;
    let loss = 0;

    // ── forward ──
    for (let t = 0; t < T; t++) {
      const h = new Float64Array(H);
      const wxCol = xs[t]; // one-hot input -> just the matching Wxh column
      const whh_h = matVec(this.Whh, hPrevT, H, H);
      for (let i = 0; i < H; i++) {
        h[i] = Math.tanh(this.Wxh[i][wxCol] + whh_h[i] + this.bh[i]);
      }
      hs[t] = h;

      const y = matVec(this.Why, h, V, H);
      for (let i = 0; i < V; i++) y[i] += this.by[i];
      // softmax
      let maxY = -Infinity;
      for (let i = 0; i < V; i++) if (y[i] > maxY) maxY = y[i];
      let sum = 0;
      const p = new Float64Array(V);
      for (let i = 0; i < V; i++) { p[i] = Math.exp(y[i] - maxY); sum += p[i]; }
      for (let i = 0; i < V; i++) p[i] /= sum;
      ps[t] = p;
      ys[t] = y;

      loss += -Math.log(Math.max(p[targets[t]], 1e-12));
      hPrevT = h;
    }

    // ── backward (BPTT) ──
    const dWxh = zerosMat(H, V), dWhh = zerosMat(H, H), dWhy = zerosMat(V, H);
    const dbh = zerosVec(H), dby = zerosVec(V);
    let dhnext = zerosVec(H);

    for (let t = T - 1; t >= 0; t--) {
      const dy = new Float64Array(ps[t]);
      dy[targets[t]] -= 1;

      const h = hs[t];
      for (let i = 0; i < V; i++) {
        dby[i] += dy[i];
        const row = dWhy[i];
        for (let j = 0; j < H; j++) row[j] += dy[i] * h[j];
      }

      const dh = matTVec(this.Why, dy, V, H);
      for (let i = 0; i < H; i++) dh[i] += dhnext[i];

      const dhraw = new Float64Array(H);
      for (let i = 0; i < H; i++) dhraw[i] = (1 - h[i] * h[i]) * dh[i];

      for (let i = 0; i < H; i++) dbh[i] += dhraw[i];

      const wxCol = xs[t];
      for (let i = 0; i < H; i++) dWxh[i][wxCol] += dhraw[i];

      const hPrev = t === 0 ? hprev : hs[t - 1];
      for (let i = 0; i < H; i++) {
        const row = dWhh[i];
        const dhi = dhraw[i];
        for (let j = 0; j < H; j++) row[j] += dhi * hPrev[j];
      }

      dhnext = matTVec(this.Whh, dhraw, H, H);
    }

    // clip gradients — standard RNN stabilizer, prevents exploding grads
    const clipMat = (m) => { for (const row of m) for (let j = 0; j < row.length; j++) row[j] = clip(row[j], -5, 5); };
    const clipVec = (v) => { for (let j = 0; j < v.length; j++) v[j] = clip(v[j], -5, 5); };
    clipMat(dWxh); clipMat(dWhh); clipMat(dWhy); clipVec(dbh); clipVec(dby);

    // Adagrad update
    const adagrad = (param, dparam, mem) => {
      for (let i = 0; i < param.length; i++) {
        const prow = param[i], drow = dparam[i], mrow = mem[i];
        for (let j = 0; j < prow.length; j++) {
          mrow[j] += drow[j] * drow[j];
          prow[j] += -this.learningRate * drow[j] / Math.sqrt(mrow[j] + 1e-8);
        }
      }
    };
    const adagradVec = (param, dparam, mem) => {
      for (let i = 0; i < param.length; i++) {
        mem[i] += dparam[i] * dparam[i];
        param[i] += -this.learningRate * dparam[i] / Math.sqrt(mem[i] + 1e-8);
      }
    };
    adagrad(this.Wxh, dWxh, this.mWxh);
    adagrad(this.Whh, dWhh, this.mWhh);
    adagrad(this.Why, dWhy, this.mWhy);
    adagradVec(this.bh, dbh, this.mbh);
    adagradVec(this.by, dby, this.mby);

    return { loss, hnext: hs[T - 1] };
  }

  // Train on an arbitrary chunk of text using a sliding window of
  // seqLength characters, carrying the hidden state forward across
  // the whole text (matches how the original min-char-rnn streams
  // a big corpus, just applied to whatever text we hand it).
  trainOnText(text, seqLength = 25) {
    if (!text || text.length < 2) return this.smoothLoss;
    const indices = textToIndices(text);
    let hprev = zerosVec(this.hiddenSize);

    for (let p = 0; p + 1 < indices.length; p += seqLength) {
      const inputs  = indices.slice(p, Math.min(p + seqLength, indices.length - 1));
      const targets = indices.slice(p + 1, Math.min(p + seqLength + 1, indices.length));
      if (inputs.length === 0 || inputs.length !== targets.length) continue;

      const { loss, hnext } = this._step(inputs, targets, hprev);
      hprev = hnext;
      this.smoothLoss = this.smoothLoss * 0.999 + (loss / inputs.length) * 0.001;
      this.totalCharsTrained += inputs.length;
    }
    return this.smoothLoss;
  }

  // Forward-only pass over `prompt` (no learning) to build up a
  // hidden state, then sample `n` new characters from there.
  // temperature < 1 = more conservative/repetitive, > 1 = wilder.
  generate(prompt, n = 200, temperature = 0.6) {
    const H = this.hiddenSize, V = this.vocabSize;
    let h = zerosVec(H);
    const promptIx = textToIndices(prompt || " ");
    let lastIx = promptIx[promptIx.length - 1] ?? CHAR_TO_IX[" "];

    for (const ix of promptIx) {
      const whh_h = matVec(this.Whh, h, H, H);
      const hNew = new Float64Array(H);
      for (let i = 0; i < H; i++) hNew[i] = Math.tanh(this.Wxh[i][ix] + whh_h[i] + this.bh[i]);
      h = hNew;
    }

    let out = "";
    for (let t = 0; t < n; t++) {
      const whh_h = matVec(this.Whh, h, H, H);
      const hNew = new Float64Array(H);
      for (let i = 0; i < H; i++) hNew[i] = Math.tanh(this.Wxh[i][lastIx] + whh_h[i] + this.bh[i]);
      h = hNew;

      const y = matVec(this.Why, h, V, H);
      for (let i = 0; i < V; i++) y[i] = (y[i] + this.by[i]) / Math.max(temperature, 1e-3);
      let maxY = -Infinity;
      for (let i = 0; i < V; i++) if (y[i] > maxY) maxY = y[i];
      let sum = 0;
      const p = new Float64Array(V);
      for (let i = 0; i < V; i++) { p[i] = Math.exp(y[i] - maxY); sum += p[i]; }
      for (let i = 0; i < V; i++) p[i] /= sum;

      // sample from the distribution
      const r = Math.random();
      let acc = 0, chosen = V - 1;
      for (let i = 0; i < V; i++) { acc += p[i]; if (r <= acc) { chosen = i; break; } }

      if (chosen === UNK_IX) { chosen = CHAR_TO_IX[" "]; }
      const ch = indexToChar(chosen);
      if (ch === "\n" && out.includes("\n")) break; // stop at a natural second line break
      out += ch;
      lastIx = chosen;
      if (out.length > 4 && /(.)\1{6,}/.test(out)) break; // stop degenerate repetition early
    }
    return out.trim();
  }

  // ── (de)serialization for persistence to disk ──
  toJSON() {
    const flat = (m) => m.map(row => Array.from(row));
    return {
      hiddenSize: this.hiddenSize,
      vocabSize: this.vocabSize,
      Wxh: flat(this.Wxh), Whh: flat(this.Whh), Why: flat(this.Why),
      bh: Array.from(this.bh), by: Array.from(this.by),
      mWxh: flat(this.mWxh), mWhh: flat(this.mWhh), mWhy: flat(this.mWhy),
      mbh: Array.from(this.mbh), mby: Array.from(this.mby),
      learningRate: this.learningRate,
      totalCharsTrained: this.totalCharsTrained,
      smoothLoss: this.smoothLoss,
    };
  }

  static fromJSON(obj) {
    if (!obj || obj.vocabSize !== VOCAB_SIZE) return null; // vocab changed — start fresh rather than load garbage
    const m = new RNNLanguageModel(obj.hiddenSize || 128);
    const toMat = (arr) => arr.map(row => Float64Array.from(row));
    m.Wxh = toMat(obj.Wxh); m.Whh = toMat(obj.Whh); m.Why = toMat(obj.Why);
    m.bh = Float64Array.from(obj.bh); m.by = Float64Array.from(obj.by);
    m.mWxh = toMat(obj.mWxh); m.mWhh = toMat(obj.mWhh); m.mWhy = toMat(obj.mWhy);
    m.mbh = Float64Array.from(obj.mbh); m.mby = Float64Array.from(obj.mby);
    m.learningRate = obj.learningRate ?? 0.08;
    m.totalCharsTrained = obj.totalCharsTrained || 0;
    m.smoothLoss = obj.smoothLoss ?? m.smoothLoss;
    return m;
  }
}

module.exports = {
  RNNLanguageModel,
  VOCAB_SIZE,
  textToIndices,
  indexToChar,
};
