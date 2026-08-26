/**
 * 313 判卷 - 百度高精度 OCR 转发 Worker（Cloudflare Workers 免费托管）
 *
 * 作用：网页（GitHub Pages / 手机）无法直连百度 OCR（被 CORS 拦），
 *      这个 Worker 在云端帮页面转发一次请求，并把百度的高精度识别结果
 *      原样带回，从而让纯静态网页也能用上接近 aistudio 的手写识别质量。
 *
 * 协议（与本地 server.py 的 /ocr 完全一致）：
 *   POST /ocr
 *   body: { "api_key":"...", "secret_key":"...", "image":"<图片的 base64>" }
 *   resp: { "ok":true, "texts":["..."], "items":[{"text":"...","points":[[x,y],...]}] }
 *        或 { "ok":false, "error":"..." }
 *
 * 部署方法见同目录 README.md（免费、约 2 分钟）。
 */
const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const OCR_URL = "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// 简单的进程内 token 缓存：百度 token 有效期 30 天，这里按 6 小时刷新一次已足够。
const tokenCache = {};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

async function getToken(ak, sk) {
  const hit = tokenCache[ak];
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.token;
  const url =
    `${TOKEN_URL}?grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(ak)}` +
    `&client_secret=${encodeURIComponent(sk)}`;
  const r = await fetch(url, { method: "POST" });
  const j = await r.json();
  if (!j.access_token) {
    throw new Error(
      "获取百度 access_token 失败：" + (j.error_description || JSON.stringify(j).slice(0, 200))
    );
  }
  tokenCache[ak] = { token: j.access_token, t: Date.now() };
  return j.access_token;
}

async function handleOcr(body) {
  const ak = (body.api_key || "").trim();
  const sk = (body.secret_key || "").trim();
  const img = (body.image || "").trim();
  if (!ak || !sk) return json(400, { ok: false, error: "缺少 api_key / secret_key" });
  if (!img) return json(400, { ok: false, error: "缺少 image" });

  const token = await getToken(ak, sk);
  const form = new URLSearchParams();
  form.append("image", img);
  form.append("detect_direction", "true");

  const r = await fetch(
    `${OCR_URL}?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }
  );
  const j = await r.json();

  if (j.error_code) {
    // token 失效：清缓存，提示重试（下次请求会自动重新换取）
    if (j.error_code === 110) {
      delete tokenCache[ak];
      return json(200, { ok: false, error: "token 失效，请重试一次" });
    }
    return json(200, {
      ok: false,
      error: j.error_msg || "百度返回错误码 " + j.error_code,
    });
  }

  const items = (j.words_result || []).map((w) => {
    const l = w.location || {};
    const left = l.left || 0, top = l.top || 0;
    const width = l.width || 0, height = l.height || 0;
    return {
      text: w.words || "",
      points: [
        [left, top],
        [left + width, top],
        [left + width, top + height],
        [left, top + height],
      ],
    };
  });
  return json(200, { ok: true, texts: items.map((x) => x.text), items });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);

    if (request.method === "POST" && (url.pathname === "/" || url.pathname.endsWith("/ocr"))) {
      let body = {};
      try {
        body = await request.json();
      } catch (e) {
        return json(400, { ok: false, error: "请求体不是合法 JSON" });
      }
      try {
        return await handleOcr(body);
      } catch (e) {
        return json(200, { ok: false, error: (e && e.message) || String(e) });
      }
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname.endsWith("/health"))) {
      return json(200, { ok: true, service: "313-grader baidu ocr proxy" });
    }

    return json(404, { ok: false, error: "not found" });
  },
};