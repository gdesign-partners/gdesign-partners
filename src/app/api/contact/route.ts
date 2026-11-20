// 問い合わせ受付API（会社LP・会社HP 共用）
// 旧: uno@ 所有の GAS ウェブアプリ → 人のアカウントに依存しないサーバー受付へ移行（2026-11）。
// ① メール（Workspace SMTPリレー）② kintone記録（任意）③ Slack通知（任意）
import nodemailer from "nodemailer";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Payload = Record<string, string>;

const MAX_FIELD = 2000;
const MAX_BODY = 20_000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;

// LP共通の既知項目（これ以外の項目はLP固有selectとして本文末尾に出す）
const KNOWN_KEYS = new Set([
  "source", "lp", "env", "name", "company", "email", "situation", "plan",
  "challenge", "issue", "message", "position", "tel", "consulting_type", "website",
]);

const isStaging = () => process.env.STAGING_MODE === "true";

// ---- 連投制限（プロセス内メモリ。pm2 1プロセス前提） ----
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_MAX;
}

// ---- 入力の正規化 ----
function sanitize(raw: unknown): Payload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Payload = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_]{1,40}$/.test(k) || k.startsWith("_")) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    out[k] = String(v).slice(0, MAX_FIELD).trim();
  }
  return out;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const isEmail = (s: string) => /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(s);

function jstNow(): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}

function extraPairs(d: Payload): [string, string][] {
  return Object.entries(d).filter(([k, v]) => !KNOWN_KEYS.has(k) && v !== "");
}

// ---- 文面（GAS版と同じ形式） ----
type Composed = { subject: string; text: string; slack: string };

function composeLp(d: Payload, staging: boolean, received: string): Composed {
  const lp = d.lp || "(LP不明)";
  const challenge = d.challenge || d.issue || d.message || "";
  const subject = `${staging ? "【LPテスト】" : ""}【LP問い合わせ】${lp} / ${d.name || "名前未入力"}`;
  const lines = [
    staging ? "※ステージング(テスト)環境からの送信です。\n" : "",
    "会社LPに問い合わせがありました。",
    "",
    `LP: ${lp}`,
    `お名前: ${d.name || ""}`,
    `会社名: ${d.company || ""}`,
    `メール: ${d.email || ""}`,
    `状況: ${d.situation || ""}`,
    `プラン: ${d.plan || ""}`,
    `課題: ${challenge}`,
    ...extraPairs(d).map(([k, v]) => `${k}: ${v}`),
    "",
    `受信日時: ${received}`,
  ];
  let slack =
    `:email: *LP問い合わせ*${staging ? " :test_tube: *[テスト]*" : ""}\n` +
    `*LP:* ${lp}\n*お名前:* ${d.name || ""}\n*会社名:* ${d.company || ""}\n` +
    `*メール:* ${d.email || ""}\n*状況:* ${d.situation || ""}\n*プラン:* ${d.plan || ""}\n*課題:* ${challenge}`;
  for (const [k, v] of extraPairs(d)) slack += `\n*${k}:* ${v}`;
  return { subject, text: lines.join("\n"), slack };
}

function composeHp(d: Payload, staging: boolean, received: string): Composed {
  const subject = `${staging ? "【HPテスト】" : ""}【HP問い合わせ】${d.consulting_type || "相談内容未選択"} / ${d.name || "名前未入力"}`;
  const lines = [
    staging ? "※ステージング(テスト)環境からの送信です。\n" : "",
    "会社HPに問い合わせがありました。",
    "",
    `お名前: ${d.name || ""}`,
    `会社名: ${d.company || ""}`,
    `役職名: ${d.position || ""}`,
    `電話番号: ${d.tel || ""}`,
    `メール: ${d.email || ""}`,
    `ご相談内容: ${d.consulting_type || ""}`,
    `詳細・ご質問: ${d.message || ""}`,
    "",
    `受信日時: ${received}`,
  ];
  const slack =
    `:email: *会社HP問い合わせ*${staging ? " :test_tube: *[テスト]*" : ""}\n` +
    `*お名前:* ${d.name || ""}\n*会社名:* ${d.company || ""}\n*役職名:* ${d.position || ""}\n` +
    `*電話番号:* ${d.tel || ""}\n*メール:* ${d.email || ""}\n` +
    `*ご相談内容:* ${d.consulting_type || ""}\n*詳細:* ${d.message || ""}`;
  return { subject, text: lines.join("\n"), slack };
}

// ---- 送信経路 ----
async function sendMail(c: Composed, replyTo: string, staging: boolean): Promise<void> {
  const host = process.env.SMTP_HOST;
  const from = process.env.MAIL_FROM;
  const to = staging ? process.env.MAIL_TO_STAGING : process.env.MAIL_TO;
  if (!host || !from || !to) throw new Error("mail not configured");
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    // 本番はTLS必須。ローカル検証用の偽SMTPに限り SMTP_REQUIRE_TLS=false で無効化できる
    requireTLS: port !== 465 && process.env.SMTP_REQUIRE_TLS !== "false",
    name: process.env.SMTP_HELO_NAME || "gdesign-partners.co.jp",
  });
  await transporter.sendMail({
    from,
    to,
    replyTo,
    subject: oneLine(c.subject),
    text: c.text,
  });
}

async function recordKintone(d: Payload, staging: boolean, received: string): Promise<void> {
  const base = process.env.KINTONE_BASE_URL;
  const app = process.env.KINTONE_APP_ID;
  const token = process.env.KINTONE_API_TOKEN;
  if (!base || !app || !token) return;
  const v = (value: string) => ({ value });
  const res = await fetch(`${base.replace(/\/$/, "")}/k/v1/record.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cybozu-API-Token": token },
    body: JSON.stringify({
      app,
      record: {
        received_at: v(received),
        env: v(staging ? "staging" : "production"),
        source: v(d.source === "hp" ? "hp" : "lp"),
        lp: v(d.lp || ""),
        name: v(d.name || ""),
        company: v(d.company || ""),
        email: v(d.email || ""),
        tel: v(d.tel || ""),
        topic: v(d.consulting_type || d.plan || d.situation || ""),
        message: v(d.message || d.challenge || d.issue || ""),
        raw: v(JSON.stringify(d)),
      },
    }),
  });
  if (!res.ok) throw new Error(`kintone ${res.status}`);
}

async function notifySlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`slack ${res.status}`);
}

// ---- 入口 ----
export async function POST(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "").split(",")[0].trim();

  const bodyText = await req.text();
  if (bodyText.length > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 400 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const d = sanitize(parsed);
  if (!d) return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });

  // ハニーポット（人には見えない項目に値がある＝ボット）。成功扱いで破棄。
  if (d.website) return NextResponse.json({ ok: true });

  d.name = oneLine(d.name || "");
  d.email = oneLine(d.email || "");
  if (!d.name || !isEmail(d.email)) {
    return NextResponse.json({ ok: false, error: "missing_required" }, { status: 400 });
  }

  // 連投制限：受付可能な送信のみ数える。IPが取れない／プロキシ自身のIPしか見えない場合
  // （nginxが X-Forwarded-For を渡していない構成）は全員を同一視してしまうため制限しない
  const isProxyOnly = !ip || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!isProxyOnly && rateLimited(ip)) {
    return NextResponse.json({ ok: false, error: "too_many_requests" }, { status: 429 });
  }

  const staging = isStaging();
  const received = jstNow();
  const composed = d.source === "hp" ? composeHp(d, staging, received) : composeLp(d, staging, received);

  const [mail, record, slack] = await Promise.allSettled([
    sendMail(composed, d.email, staging),
    recordKintone(d, staging, received),
    notifySlack(composed.slack),
  ]);
  for (const [label, r] of [["mail", mail], ["kintone", record], ["slack", slack]] as const) {
    if (r.status === "rejected") console.error(`[contact] ${label} failed:`, String(r.reason));
  }

  const recordConfigured = Boolean(process.env.KINTONE_API_TOKEN);
  const slackConfigured = Boolean(process.env.SLACK_WEBHOOK_URL);
  const delivered =
    mail.status === "fulfilled" ||
    (recordConfigured && record.status === "fulfilled") ||
    (slackConfigured && slack.status === "fulfilled");

  if (!delivered) {
    console.error("[contact] all channels failed", JSON.stringify(d));
    return NextResponse.json({ ok: false, error: "delivery_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
