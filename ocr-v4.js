/* PP-OCRv4 浏览器端识别引擎（onnxruntime-web + WASM 单线程）
 * 依赖：./v4/ort.min.js、./v4/det.onnx、./v4/rec_fixed.onnx、./v4/keys.txt
 */
(function (global) {
  "use strict";

  let engine = null;

  async function loadOrtScript() {
    if (global.ort) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "./v4/ort.min.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("onnxruntime 加载失败"));
      document.head.appendChild(s);
    });
  }

  async function load() {
    if (engine) return engine;
    await loadOrtScript();
    const ort = global.ort;
    ort.env.wasm.wasmPaths = new URL("./v4/", document.baseURI).href;
    ort.env.wasm.numThreads = 1;
    const base = document.baseURI;
    const det = await ort.InferenceSession.create(new URL("./v4/det.onnx", base).href);
    const rec = await ort.InferenceSession.create(new URL("./v4/rec_v3_fixed.onnx", base).href);
    const keysText = await (await fetch(new URL("./v4/keys.txt", base).href)).text();
    const keys = keysText.split("\n");
    engine = { ort, det, rec, keys, ready: true };
    return engine;
  }

  /* 图片 → NCHW float tensor（缩放 + 归一化），不 pad */
  function imageToTensor(srcCanvas, w, h, mean, std) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const data = new Float32Array(3 * w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[0 * w * h + y * w + x] = (d[i] / 255 - mean[0]) / std[0];
        data[1 * w * h + y * w + x] = (d[i + 1] / 255 - mean[1]) / std[1];
        data[2 * w * h + y * w + x] = (d[i + 2] / 255 - mean[2]) / std[2];
      }
    }
    return data;
  }

  /* det 预处理：缩放最长边 960、pad 到 960x960 */
  function detPreprocess(img) {
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    const maxLen = 960;
    const ratio = Math.min(1, maxLen / Math.max(srcW, srcH));
    const nw = Math.max(1, Math.round(srcW * ratio));
    const nh = Math.max(1, Math.round(srcH * ratio));
    const c = document.createElement("canvas");
    c.width = 960; c.height = 960;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, 960, 960);
    ctx.drawImage(img, 0, 0, nw, nh);
    const d = ctx.getImageData(0, 0, 960, 960).data;
    const data = new Float32Array(3 * 960 * 960);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let y = 0; y < 960; y++) {
      for (let x = 0; x < 960; x++) {
        const i = (y * 960 + x) * 4;
        data[0 * 960 * 960 + y * 960 + x] = (d[i] / 255 - mean[0]) / std[0];
        data[1 * 960 * 960 + y * 960 + x] = (d[i + 1] / 255 - mean[1]) / std[1];
        data[2 * 960 * 960 + y * 960 + x] = (d[i + 2] / 255 - mean[2]) / std[2];
      }
    }
    return { tensor: new engine.ort.Tensor("float32", data, [1, 3, 960, 960]), ratio };
  }

  /* DB 后处理：二值化 + 膨胀 + 连通域 → 包围盒（960 坐标系） */
  function dbPostProcess(prob, thresh, minSize) {
    const W = 960, H = 960, N = W * H;
    const bitmap = new Uint8Array(N);
    for (let i = 0; i < N; i++) bitmap[i] = prob[i] > thresh ? 1 : 0;
    const dil = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = 0;
        for (let dy = 0; dy < 2 && !v; dy++) {
          if (y + dy >= H) break;
          for (let dx = 0; dx < 2; dx++) {
            if (x + dx >= W) break;
            if (bitmap[(y + dy) * W + x + dx]) { v = 1; break; }
          }
        }
        dil[y * W + x] = v;
      }
    }
    const visited = new Uint8Array(N);
    const boxes = [];
    const stack = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!dil[y * W + x] || visited[y * W + x]) continue;
        let minX = W, minY = H, maxX = -1, maxY = -1, count = 0;
        stack.length = 0;
        stack.push([x, y]);
        visited[y * W + x] = 1;
        while (stack.length) {
          const p = stack.pop();
          const cx = p[0], cy = p[1];
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          if (cx > 0 && !visited[cy * W + cx - 1] && dil[cy * W + cx - 1]) { visited[cy * W + cx - 1] = 1; stack.push([cx - 1, cy]); }
          if (cx < W - 1 && !visited[cy * W + cx + 1] && dil[cy * W + cx + 1]) { visited[cy * W + cx + 1] = 1; stack.push([cx + 1, cy]); }
          if (cy > 0 && !visited[(cy - 1) * W + cx] && dil[(cy - 1) * W + cx]) { visited[(cy - 1) * W + cx] = 1; stack.push([cx, cy - 1]); }
          if (cy < H - 1 && !visited[(cy + 1) * W + cx] && dil[(cy + 1) * W + cx]) { visited[(cy + 1) * W + cx] = 1; stack.push([cx, cy + 1]); }
        }
        let bw = maxX - minX + 1, bh = maxY - minY + 1;
        if (bw < minSize || bh < minSize || count < 6) continue;
        bw = maxX - minX + 1; bh = maxY - minY + 1;
        boxes.push({ x: minX, y: minY, w: bw, h: bh });
      }
    }
    return boxes;
  }

  /* 对检测框做外扩（近似 unclip）：横向 8%，纵向 40%（上下各 20%） */
  function expandBox(b, W, H) {
    const ex = Math.max(1, Math.round(b.w * 0.08));
    const ey = Math.max(1, Math.round(b.h * 0.20));
    const x = Math.max(0, b.x - ex);
    const y = Math.max(0, b.y - ey);
    const w = Math.min(W - x, b.w + ex * 2);
    const h = Math.min(H - y, b.h + ey * 2);
    return { x, y, w, h };
  }

  /* rec 预处理：裁剪框 → 高 32、宽按比例（≤320）→ 右补白到 320 */
  function recPreprocess(img, box) {
    const srcW = Math.max(2, box.w), srcH = Math.max(2, box.h);
    const targetH = 32;
    let targetW = Math.round(srcW / srcH * targetH);
    if (targetW > 640) targetW = 640;
    if (targetW < 2) targetW = 2;
    const c = document.createElement("canvas");
    c.width = srcW; c.height = srcH;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, srcW, srcH);
    ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, srcW, srcH);
    const c2 = document.createElement("canvas");
    c2.width = targetW; c2.height = targetH;
    const ctx2 = c2.getContext("2d", { willReadFrequently: true });
    ctx2.fillStyle = "#FFFFFF";
    ctx2.fillRect(0, 0, targetW, targetH);
    ctx2.drawImage(c, 0, 0, targetW, targetH);
    const d = ctx2.getImageData(0, 0, targetW, targetH).data;
    const full = new Float32Array(3 * 32 * 640);
    for (let ch = 0; ch < 3; ch++) {
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < targetW; x++) {
          const i = (y * targetW + x) * 4;
          full[ch * 32 * 640 + y * 640 + x] = (d[i + ch] / 255 - 0.5) / 0.5;
        }
      }
    }
    return new engine.ort.Tensor("float32", full, [1, 3, 32, 640]);
  }

  /* CTC 贪心解码 */
  function ctcDecode(prob, keys) {
    const seq = 80, cls = 6625;
    let out = "";
    let prev = -1;
    for (let t = 0; t < seq; t++) {
      const base = t * cls;
      let maxV = -Infinity, maxI = 0;
      for (let k = 0; k < cls; k++) {
        const v = prob[base + k];
        if (v > maxV) { maxV = v; maxI = k; }
      }
      if (maxI !== prev && maxI !== 0) {
        const ch = keys[maxI - 1];
        if (ch !== undefined && ch.trim() !== "") out += ch;
      }
      prev = maxI;
    }
    return out;
  }

  /* 主识别入口：img 为 HTMLImageElement / canvas */
  async function recognize(img) {
    const e = await load();
    // det
    const { tensor, ratio } = detPreprocess(img);
    const detOut = await e.det.run({ [e.det.inputNames[0]]: tensor });
    const prob = detOut[e.det.outputNames[0]].data;
    const boxes = dbPostProcess(prob, 0.3, 3);
    const boxesOrig = boxes
      .map(b => expandBox(b, 960, 960))
      .map(b => ({
        x: Math.max(0, Math.round(b.x / ratio)),
        y: Math.max(0, Math.round(b.y / ratio)),
        w: Math.round(b.w / ratio),
        h: Math.round(b.h / ratio)
      }))
      .filter(b => b.w > 2 && b.h > 2);
    boxesOrig.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
    // rec
    const lines = [];
    const points = [];
    for (const b of boxesOrig) {
      const t = recPreprocess(img, b);
      const recOut = await e.rec.run({ x: t });
      const text = ctcDecode(recOut[e.rec.outputNames[0]].data, e.keys);
      lines.push(text);
      points.push([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]);
    }
    return { text: lines.join("\n"), points };
  }

  global.ocrV4 = { load, recognize };
})(window);
